import assert from 'node:assert/strict'
import test from 'node:test'
import type { PaperAgentStore } from '../packages/domain/src/index.ts'
import { HybridPaperRetriever, RerankingPaperRetriever, SqlitePaperRetriever } from '../packages/retrieval/src/index.ts'
import type { PaperReranker } from '../packages/reranker-dashscope/src/index.ts'

test('the default retriever delegates all recall to the local SQLite store and keeps filters intact', async () => {
  const calls: unknown[][] = []
  const chunkHits = [{ id: 'chunk-1' }] as never
  const elementHits = [{ id: 'element-1' }] as never
  const figureHits = [{ id: 'figure-1' }] as never
  const store = {
    searchPaperChunks(...args: unknown[]) { calls.push(args); return chunkHits },
    searchPaperElements(...args: unknown[]) { calls.push(args); return elementHits },
    searchPaperFigures(...args: unknown[]) { calls.push(args); return figureHits },
  } as unknown as PaperAgentStore
  const retriever = new SqlitePaperRetriever(Promise.resolve(store))

  const chunks = await retriever.searchChunks({
    workspacePath: 'D:/workspace/research', query: 'transformer attention', limit: 4,
    filter: { libraryId: 'library-a', paperIds: ['paper-a'], section: 'Method' },
  })
  const elements = await retriever.searchElements({
    workspacePath: 'D:/workspace/research', query: 'ablation table', limit: 3, types: ['table'],
    filter: { paperIds: ['paper-a'] },
  })
  const figures = await retriever.searchFigures({ workspacePath: 'D:/workspace/research', query: 'attention map', limit: 2 })

  assert.deepEqual(chunks, { mode: 'sqlite', hits: chunkHits })
  assert.deepEqual(elements, { mode: 'sqlite', hits: elementHits })
  assert.deepEqual(figures, { mode: 'sqlite', hits: figureHits })
  assert.deepEqual(calls, [
    ['D:/workspace/research', 'transformer attention', 4, { libraryId: 'library-a', paperIds: ['paper-a'], section: 'Method' }],
    [{ workspacePath: 'D:/workspace/research', query: 'ablation table', limit: 3, types: ['table'], filter: { paperIds: ['paper-a'] } }],
    ['D:/workspace/research', 'attention map', 2],
  ])
})

test('the default retriever applies the existing local limits when callers omit them', async () => {
  const calls: unknown[][] = []
  const store = {
    searchPaperChunks(...args: unknown[]) { calls.push(args); return [] },
    searchPaperElements(...args: unknown[]) { calls.push(args); return [] },
    searchPaperFigures(...args: unknown[]) { calls.push(args); return [] },
  } as unknown as PaperAgentStore
  const retriever = new SqlitePaperRetriever(Promise.resolve(store))

  await retriever.searchChunks({ workspacePath: 'workspace', query: 'text' })
  await retriever.searchElements({ workspacePath: 'workspace', query: 'table' })
  await retriever.searchFigures({ workspacePath: 'workspace', query: 'figure' })

  assert.deepEqual(calls, [
    ['workspace', 'text', 6, {}],
    [{ workspacePath: 'workspace', query: 'table', limit: 6 }],
    ['workspace', 'figure', 6],
  ])
})

test('hybrid chunk retrieval hydrates ES candidates locally, fuses ranks with RRF, and records stages', async () => {
  const sqliteA = citation('chunk-a', 'Paper A')
  const sqliteB = citation('chunk-b', 'Paper B')
  const semanticC = citation('chunk-c', 'Paper C')
  const hydrationCalls: unknown[][] = []
  const store = {
    searchPaperChunks() { return [sqliteA, sqliteB] },
    getPaperChunkCitationsByIds(...args: unknown[]) { hydrationCalls.push(args); return [semanticC, sqliteA] },
    searchPaperElements() { return [] }, searchPaperFigures() { return [] },
  } as unknown as PaperAgentStore
  const backendCalls: unknown[] = []
  const retriever = new HybridPaperRetriever(Promise.resolve(store), {
    async embedQuery(query) { assert.equal(query, 'semantic query'); return [0.25, 0.75] },
    async searchChunks(input) {
      backendCalls.push(input)
      return [{ sourceId: 'chunk:chunk-c', score: 0.9 }, { sourceId: 'chunk:chunk-a', score: 0.8 }]
    },
    async searchElements() { return [] },
  })
  const stages: unknown[] = []

  const result = await retriever.searchChunks({ workspacePath: 'D:/workspace/research', query: 'semantic query', limit: 3, trace: { stage: value => stages.push(value) } })

  assert.equal(result.mode, 'hybrid')
  assert.deepEqual(result.hits.map(hit => hit.id), ['chunk-a', 'chunk-c', 'chunk-b'])
  assert.deepEqual(hydrationCalls, [['D:/workspace/research', ['chunk-c', 'chunk-a'], {}]])
  assert.equal((backendCalls[0] as { workspaceKey: string }).workspaceKey.length, 64)
  assert.deepEqual(stages.map(stage => (stage as { kind: string }).kind), ['embedding', 'sqlite', 'elasticsearch', 'fusion', 'final'])
  const trace = stages as Array<{
    readonly kind: string
    readonly candidates: readonly { readonly sourceId: string; readonly sqliteRank?: number; readonly elasticRank?: number; readonly fusionScore?: number }[]
  }>
  assert.deepEqual(trace.find(stage => stage.kind === 'sqlite')?.candidates.map(candidate => candidate.sqliteRank), [1, 2])
  const fusion = trace.find(stage => stage.kind === 'fusion')?.candidates
  assert.deepEqual(fusion?.map(candidate => candidate.sourceId), ['chunk-a', 'chunk-c', 'chunk-b'])
  assert.equal(fusion?.[0]?.fusionScore, 1 / 61 + 1 / 62)
  assert.deepEqual(trace.find(stage => stage.kind === 'final')?.candidates, fusion)
})

test('hybrid chunk retrieval falls back to SQLite when vector retrieval is unavailable', async () => {
  const sqliteA = citation('chunk-a', 'Paper A')
  const store = {
    searchPaperChunks() { return [sqliteA] },
    searchPaperElements() { return [] }, searchPaperFigures() { return [] },
  } as unknown as PaperAgentStore
  const retriever = new HybridPaperRetriever(Promise.resolve(store), {
    async embedQuery() { throw new Error('vector retrieval is disabled in PaperAgent settings') },
    async searchChunks() { throw new Error('unreachable') },
    async searchElements() { throw new Error('unreachable') },
  })
  const stages: Array<{ kind: string; status: string }> = []

  const result = await retriever.searchChunks({ workspacePath: 'workspace', query: 'query', trace: { stage: value => stages.push(value) } })

  assert.deepEqual(result, { mode: 'sqlite', hits: [sqliteA] })
  assert.deepEqual(stages.map(stage => [stage.kind, stage.status]), [
    ['sqlite', 'completed'], ['embedding', 'fallback'], ['final', 'fallback'],
  ])
})

test('hybrid element retrieval preserves type filters and rehydrates ES identities locally', async () => {
  const local = element('element-a', 'Table Paper', 'table')
  const semantic = element('element-b', 'Figure Paper', 'figure')
  const calls: unknown[] = []
  const store = {
    searchPaperChunks() { return [] }, searchPaperFigures() { return [] },
    searchPaperElements(input: unknown) { calls.push(['local', input]); return [local] },
    getPaperElementCitationsByIds(input: unknown) { calls.push(['hydrate', input]); return [semantic, local] },
  } as unknown as PaperAgentStore
  const retriever = new HybridPaperRetriever(Promise.resolve(store), {
    async embedQuery() { return [0.5, 0.5] }, async searchChunks() { return [] },
    async searchElements(input) { calls.push(['vector', input]); return [
      { sourceId: 'element:element-b', score: 0.8 }, { sourceId: 'element:element-a', score: 0.7 },
    ] },
  })

  const result = await retriever.searchElements({
    workspacePath: 'D:/workspace/research', query: 'comparison table', limit: 2,
    types: ['table'], filter: { section: 'Experiments' },
  })

  assert.equal(result.mode, 'hybrid')
  assert.deepEqual(result.hits.map(hit => hit.id), ['element-a', 'element-b'])
  assert.deepEqual(calls[0], ['local', {
    workspacePath: 'D:/workspace/research', query: 'comparison table', limit: 20,
    types: ['table'], filter: { section: 'Experiments' },
  }])
  const vectorInput = (calls[1] as readonly [string, {
    readonly vector: readonly number[]; readonly workspaceKey: string; readonly limit: number
    readonly filter: unknown; readonly types?: readonly string[]
  }])[1]
  assert.deepEqual(vectorInput.vector, [0.5, 0.5])
  assert.match(vectorInput.workspaceKey, /^[a-f0-9]{64}$/)
  assert.equal(vectorInput.limit, 20)
  assert.deepEqual(vectorInput.filter, { section: 'Experiments' })
  assert.deepEqual(vectorInput.types, ['table'])
  assert.deepEqual(calls[2], ['hydrate', {
    workspacePath: 'D:/workspace/research', elementIds: ['element-b', 'element-a'],
    types: ['table'], filter: { section: 'Experiments' },
  }])
})

test('hybrid figure retrieval maps vector element identities back to figure citations', async () => {
  const local = figure('figure-a', 'element-a', 'Paper A')
  const semantic = figure('figure-b', 'element-b', 'Paper B')
  const calls: unknown[] = []
  const store = {
    searchPaperChunks() { return [] }, searchPaperElements() { return [] },
    searchPaperFigures() { return [local] },
    getPaperFigureCitationsByElementIds(...args: unknown[]) { calls.push(args); return [semantic, local] },
  } as unknown as PaperAgentStore
  const retriever = new HybridPaperRetriever(Promise.resolve(store), {
    async embedQuery() { return [1] }, async searchChunks() { return [] },
    async searchElements(input) {
      assert.deepEqual(input.types, ['figure'])
      return [{ sourceId: 'element:element-b', score: 0.9 }]
    },
  })

  const result = await retriever.searchFigures({ workspacePath: 'workspace', query: 'vehicle detection', limit: 2 })

  assert.equal(result.mode, 'hybrid')
  assert.deepEqual(result.hits.map(hit => hit.id), ['figure-a', 'figure-b'])
  assert.deepEqual(calls, [['workspace', ['element-b']]])
})

test('optional reranker expands candidates, records rerank scores, and returns the ranked subset', async () => {
  const first = citation('chunk-a', 'Paper A')
  const second = citation('chunk-b', 'Paper B')
  const third = citation('chunk-c', 'Paper C')
  const calls: Array<{ limit: number | undefined; traceStages: string[] }> = []
  const base = {
    async searchChunks(input: { limit?: number; trace?: { stage(stage: { kind: string }): void } }) {
      const traceStages: string[] = []
      input.trace?.stage({ kind: 'sqlite' })
      input.trace?.stage({ kind: 'final' })
      calls.push({ limit: input.limit, traceStages })
      return { mode: 'sqlite' as const, hits: [first, second, third] }
    },
    async searchElements() { return { mode: 'sqlite' as const, hits: [] as never[] } },
    async searchFigures() { return { mode: 'sqlite' as const, hits: [] as never[] } },
  }
  const reranker: PaperReranker = {
    async rerank(input) {
      assert.equal(input.query.text, 'find paper B')
      assert.deepEqual(input.documents.map(document => document.sourceId), ['chunk-a', 'chunk-b', 'chunk-c'])
      return [
        { sourceId: 'chunk-b', index: 1, relevanceScore: 0.97 },
        { sourceId: 'chunk-a', index: 0, relevanceScore: 0.41 },
      ]
    },
  }
  const stages: Array<{ kind: string; status: string; candidates: readonly { sourceId: string; rerankScore?: number }[] }> = []
  const retriever = new RerankingPaperRetriever(base, reranker, { candidateLimit: 3 })
  const result = await retriever.searchChunks({ workspacePath: 'workspace', query: 'find paper B', limit: 2, trace: { stage: stage => stages.push(stage as never) } })

  assert.deepEqual(result.hits.map(hit => hit.id), ['chunk-b', 'chunk-a'])
  assert.equal(calls[0]?.limit, 3)
  assert.deepEqual(stages.map(stage => stage.kind), ['sqlite', 'rerank', 'final'])
  assert.deepEqual(stages.find(stage => stage.kind === 'rerank')?.candidates.map(candidate => candidate.sourceId), ['chunk-b', 'chunk-a'])
  assert.deepEqual(stages.find(stage => stage.kind === 'rerank')?.candidates.map(candidate => candidate.rerankScore), [0.97, 0.41])
})

test('optional reranker falls back to the local order when the provider fails', async () => {
  const first = citation('chunk-a', 'Paper A')
  const second = citation('chunk-b', 'Paper B')
  const base = {
    async searchChunks() { return { mode: 'sqlite' as const, hits: [first, second] } },
    async searchElements() { return { mode: 'sqlite' as const, hits: [] as never[] } },
    async searchFigures() { return { mode: 'sqlite' as const, hits: [] as never[] } },
  }
  const stages: Array<{ kind: string; status: string; reason?: string }> = []
  const retriever = new RerankingPaperRetriever(base, { async rerank() { throw new Error('provider timeout') } })
  const result = await retriever.searchChunks({ workspacePath: 'workspace', query: 'query', limit: 1, trace: { stage: stage => stages.push(stage as never) } })

  assert.deepEqual(result.hits.map(hit => hit.id), ['chunk-a'])
  assert.deepEqual(stages.map(stage => [stage.kind, stage.status]), [['rerank', 'fallback'], ['final', 'fallback']])
  assert.equal(stages[0]?.reason, 'provider timeout')
})

test('figure reranking can opt into image Data URIs without exposing the local path', async () => {
  const hit = figure('figure-a', 'element-a', 'Paper A')
  let seenImage: string | undefined
  const base = {
    async searchChunks() { return { mode: 'sqlite' as const, hits: [] as never[] } },
    async searchElements() { return { mode: 'sqlite' as const, hits: [] as never[] } },
    async searchFigures() { return { mode: 'sqlite' as const, hits: [hit] } },
  }
  const retriever = new RerankingPaperRetriever(base, {
    async rerank(input) {
      seenImage = input.documents[0]?.imageDataUri
      assert.match(input.documents[0]?.text ?? '', /Paper A caption/)
      return [{ sourceId: hit.id, index: 0, relevanceScore: 0.88 }]
    },
  }, { includeFigureImages: true, loadFigureImage: async figure => `data:image/png;base64,${figure.id}` })

  const result = await retriever.searchFigures({ workspacePath: 'workspace', query: 'figure', limit: 1 })
  assert.equal(result.hits[0]?.id, hit.id)
  assert.equal(seenImage, 'data:image/png;base64,figure-a')
})

function citation(id: string, title: string) {
  return {
    id, paperId: `paper-${id}`, title, section: 'Method', pdfPageStart: 2, pdfPageEnd: 2,
    markdownPath: `${id}.md`, lineStart: 10, lineEnd: 20, excerpt: `${title} excerpt`,
  }
}

function element(id: string, title: string, elementType: string) {
  return {
    id, paperId: `paper-${id}`, title, elementType, elementLabel: '', section: 'Experiments',
    pdfPageStart: 2, pdfPageEnd: 2, markdownPath: `${id}.md`, lineStart: 10, lineEnd: 20,
    content: `${title} content`, caption: null,
  }
}

function figure(id: string, elementId: string, title: string) {
  return {
    id, paperId: `paper-${id}`, elementId, title, figureLabel: null, sectionTitle: 'Experiments',
    pdfPage: 3, rawCaption: `${title} caption`, visionDescription: null, imagePath: `${id}.png`,
  }
}
