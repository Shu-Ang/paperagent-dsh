/**
 * Stable retrieval boundary for PaperAgent tools.
 *
 * External vector backends can nominate candidates, but only SQLite creates
 * citations. This keeps workspace isolation and PDF coordinates independent
 * from Elasticsearch's rebuildable projections.
 */

import { createHash } from 'node:crypto'
import { canonicalWorkspace, STRUCTURED_PAPER_ELEMENT_TYPES } from '@paperagent/domain'
import type { PaperReranker, RerankDocument } from '@paperagent/reranker-dashscope'
import type {
  PaperAgentStore,
  PaperCitation,
  PaperElementCitation,
  PaperElementType,
  PaperFigureCitation,
  PaperSearchFilter,
} from '@paperagent/domain'

export type RetrievalMode = 'sqlite' | 'vector' | 'hybrid'
export type RetrievalTraceStageKind = 'sqlite' | 'embedding' | 'elasticsearch' | 'fusion' | 'rerank' | 'final'
export type RetrievalTraceStageStatus = 'completed' | 'skipped' | 'fallback' | 'failed'

/** Bounded, presentation-safe data for one candidate; vectors and secrets are never recorded. */
export interface RetrievalTraceCandidate {
  readonly sourceId: string
  readonly paperId: string
  readonly title: string
  readonly section: string
  readonly pdfPageStart: number
  readonly rank: number
  readonly score?: number
  readonly sqliteRank?: number
  readonly elasticRank?: number
  readonly fusionScore?: number
  readonly rerankScore?: number
  readonly excerpt: string
}

export interface RetrievalTraceStage {
  readonly kind: RetrievalTraceStageKind
  readonly status: RetrievalTraceStageStatus
  readonly durationMs: number
  readonly method?: 'fts' | 'knn' | 'rrf' | 'dashscope-rerank'
  readonly reason?: string
  readonly candidates: readonly RetrievalTraceCandidate[]
}

/** Per-call sink; never share an instance between concurrent tool executions. */
export interface RetrievalTraceSink {
  stage(stage: RetrievalTraceStage): void
}

export interface RetrievalResult<Hit> {
  readonly mode: RetrievalMode
  readonly hits: readonly Hit[]
}

export interface ChunkRetrievalInput {
  readonly workspacePath: string
  readonly query: string
  readonly limit?: number
  readonly filter?: PaperSearchFilter
  readonly trace?: RetrievalTraceSink
}

export interface ElementRetrievalInput {
  readonly workspacePath: string
  readonly query: string
  readonly limit?: number
  readonly types?: readonly PaperElementType[]
  readonly filter?: PaperSearchFilter
  readonly trace?: RetrievalTraceSink
}

export interface FigureRetrievalInput {
  readonly workspacePath: string
  readonly query: string
  readonly limit?: number
  readonly trace?: RetrievalTraceSink
}

/** The only retrieval dependency used by Agent search tools. */
export interface PaperRetriever {
  searchChunks(input: ChunkRetrievalInput): Promise<RetrievalResult<PaperCitation>>
  searchElements(input: ElementRetrievalInput): Promise<RetrievalResult<PaperElementCitation>>
  searchFigures(input: FigureRetrievalInput): Promise<RetrievalResult<PaperFigureCitation>>
}

/** Default local-first retriever backed by SQLite FTS/lexical indexes. */
export class SqlitePaperRetriever implements PaperRetriever {
  constructor(private readonly storePromise: Promise<PaperAgentStore>) {}

  async searchChunks(input: ChunkRetrievalInput): Promise<RetrievalResult<PaperCitation>> {
    const startedAt = now()
    const store = await this.storePromise
    const hits = store.searchPaperChunks(input.workspacePath, input.query, input.limit ?? 6, input.filter ?? {})
    input.trace?.stage(traceStage('sqlite', 'completed', startedAt, hits, { method: 'fts', sqliteRanks: true }))
    input.trace?.stage(traceStage('final', 'completed', now(), hits, { sqliteRanks: true }))
    return { mode: 'sqlite', hits }
  }

  async searchElements(input: ElementRetrievalInput): Promise<RetrievalResult<PaperElementCitation>> {
    const startedAt = now()
    const store = await this.storePromise
    const hits = store.searchPaperElements({
      workspacePath: input.workspacePath,
      query: input.query,
      limit: input.limit ?? 6,
      ...(input.types === undefined ? {} : { types: input.types }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
    })
    input.trace?.stage(traceStage('sqlite', 'completed', startedAt, hits, { method: 'fts', sqliteRanks: true }))
    input.trace?.stage(traceStage('final', 'completed', now(), hits, { sqliteRanks: true }))
    return { mode: 'sqlite', hits }
  }

  async searchFigures(input: FigureRetrievalInput): Promise<RetrievalResult<PaperFigureCitation>> {
    const startedAt = now()
    const store = await this.storePromise
    const hits = store.searchPaperFigures(input.workspacePath, input.query, input.limit ?? 6)
    input.trace?.stage(traceStage('sqlite', 'completed', startedAt, hits, { method: 'fts', sqliteRanks: true }))
    input.trace?.stage(traceStage('final', 'completed', now(), hits, { sqliteRanks: true }))
    return { mode: 'sqlite', hits }
  }
}

export interface RerankingPaperRetrieverOptions {
  readonly candidateLimit?: number
  /** Provider top_n used when a tool call does not specify its own limit. */
  readonly topN?: number
  readonly instruct?: string
  /** Enable loading figure binaries for qwen3-vl-rerank. */
  readonly includeFigureImages?: boolean
  readonly loadFigureImage?: (figure: PaperFigureCitation) => Promise<string | undefined>
  /** Optional durable switch checked immediately before each search. */
  readonly isEnabled?: () => Promise<boolean>
}

/**
 * Optional final precision stage shared by SQLite-only and hybrid retrieval.
 *
 * The base retriever still owns candidate hydration and evidence coordinates.
 * Reranking only changes the order and never becomes the source of citation
 * content. A provider failure deliberately falls back to the base order.
 */
export class RerankingPaperRetriever implements PaperRetriever {
  private readonly candidateLimit: number

  constructor(
    private readonly base: PaperRetriever,
    private readonly reranker: PaperReranker,
    private readonly options: RerankingPaperRetrieverOptions = {},
  ) {
    this.candidateLimit = bounded(options.candidateLimit ?? 20, 1, 50)
  }

  async searchChunks(input: ChunkRetrievalInput): Promise<RetrievalResult<PaperCitation>> {
    return this.run(input, trace => this.base.searchChunks({
      ...input, limit: this.candidateLimit, ...(trace === undefined ? {} : { trace }),
    }), hit => ({
      sourceId: hit.id,
      text: renderChunkForRerank(hit),
    }))
  }

  async searchElements(input: ElementRetrievalInput): Promise<RetrievalResult<PaperElementCitation>> {
    return this.run(input, trace => this.base.searchElements({
      ...input, limit: this.candidateLimit, ...(trace === undefined ? {} : { trace }),
    }), hit => ({
      sourceId: hit.id,
      text: renderElementForRerank(hit),
    }))
  }

  async searchFigures(input: FigureRetrievalInput): Promise<RetrievalResult<PaperFigureCitation>> {
    return this.run(input, trace => this.base.searchFigures({
      ...input, limit: this.candidateLimit, ...(trace === undefined ? {} : { trace }),
    }), async hit => {
      const imageDataUri = this.options.includeFigureImages === true && this.options.loadFigureImage !== undefined
        ? await this.options.loadFigureImage(hit)
        : undefined
      return {
        sourceId: hit.id,
        text: renderFigureForRerank(hit),
        ...(imageDataUri === undefined ? {} : { imageDataUri }),
      }
    })
  }

  private async run<Hit extends TraceableHit>(
    input: { readonly query: string; readonly limit?: number; readonly trace?: RetrievalTraceSink },
    execute: (trace?: RetrievalTraceSink) => Promise<RetrievalResult<Hit>>,
    buildDocument: (hit: Hit) => RerankDocument | Promise<RerankDocument>,
  ): Promise<RetrievalResult<Hit>> {
    const finalLimit = bounded(input.limit ?? this.options.topN ?? 6, 1, 20)
    const enabled = await (this.options.isEnabled?.() ?? Promise.resolve(true))
    const baseResult = await execute(enabled ? suppressFinalTrace(input.trace) : input.trace)
    if (!enabled) return baseResult
    const candidates = dedupeHits(baseResult.hits).slice(0, this.candidateLimit)
    if (candidates.length === 0) {
      input.trace?.stage({ kind: 'rerank', status: 'skipped', durationMs: 0, method: 'dashscope-rerank', reason: 'no candidates', candidates: [] })
      input.trace?.stage({ kind: 'final', status: 'completed', durationMs: 0, candidates: [] })
      return { mode: baseResult.mode, hits: [] }
    }

    const startedAt = now()
    try {
      const documents = await Promise.all(candidates.map(buildDocument))
      const results = await this.reranker.rerank({
        query: { text: input.query },
        documents,
        topN: Math.min(finalLimit, candidates.length),
        ...(this.options.instruct === undefined ? {} : { instruct: this.options.instruct }),
      })
      const candidateById = new Map(candidates.map(hit => [hit.id, hit] as const))
      const ranked = results.flatMap(result => {
        const hit = candidateById.get(result.sourceId)
        return hit === undefined ? [] : [{ hit, score: result.relevanceScore }]
      })
      if (ranked.length === 0) throw new Error('DashScope rerank returned no known candidates')
      const finalEntries = ranked.slice(0, finalLimit)
      input.trace?.stage({
        kind: 'rerank', status: 'completed', durationMs: elapsed(startedAt), method: 'dashscope-rerank',
        candidates: ranked.slice(0, 30).map((entry, index) => candidateFor(entry.hit, index + 1, { rerankScore: entry.score })),
      })
      input.trace?.stage({
        kind: 'final', status: 'completed', durationMs: 0,
        candidates: finalEntries.map((entry, index) => candidateFor(entry.hit, index + 1, { rerankScore: entry.score })),
      })
      return { mode: baseResult.mode, hits: finalEntries.map(entry => entry.hit) }
    } catch (error) {
      const reason = safeReason(error)
      const fallback = candidates.slice(0, finalLimit)
      input.trace?.stage({
        kind: 'rerank', status: 'fallback', durationMs: elapsed(startedAt), method: 'dashscope-rerank',
        reason, candidates: [],
      })
      input.trace?.stage({
        kind: 'final', status: 'fallback', durationMs: 0, reason,
        candidates: fallback.map((hit, index) => candidateFor(hit, index + 1)),
      })
      return { mode: baseResult.mode, hits: fallback }
    }
  }
}

export interface VectorCandidate {
  /** The source id written to the vector projection, for example `chunk:<id>`. */
  readonly sourceId: string
  readonly score: number
}

export interface HybridSearchBackend {
  /** Returns a query vector in the same dimensions as the current index. */
  embedQuery(query: string): Promise<readonly number[]>
  /** Returns only workspace-filtered vector candidates, never citation text. */
  searchChunks(input: {
    readonly vector: readonly number[]
    readonly workspaceKey: string
    readonly limit: number
    readonly filter: PaperSearchFilter
  }): Promise<readonly VectorCandidate[]>
  /** Searches the separately versioned element projection. */
  searchElements(input: {
    readonly vector: readonly number[]
    readonly workspaceKey: string
    readonly limit: number
    readonly filter: PaperSearchFilter
    readonly types?: readonly PaperElementType[]
  }): Promise<readonly VectorCandidate[]>
}

export interface HybridRetrieverOptions {
  readonly candidateLimit?: number
  readonly rrfK?: number
}

/**
 * Hybrid retrieval: SQLite is always available; vector failure is a
 * controlled fallback, not a tool failure. Elasticsearch only nominates
 * identities; local SQLite owns current revisions and citation coordinates.
 */
export class HybridPaperRetriever implements PaperRetriever {
  private readonly candidateLimit: number
  private readonly rrfK: number

  constructor(
    private readonly storePromise: Promise<PaperAgentStore>,
    private readonly backend: HybridSearchBackend,
    options: HybridRetrieverOptions = {},
  ) {
    this.candidateLimit = bounded(options.candidateLimit ?? 20, 1, 50)
    this.rrfK = bounded(options.rrfK ?? 60, 1, 1_000)
  }

  async searchChunks(input: ChunkRetrievalInput): Promise<RetrievalResult<PaperCitation>> {
    const store = await this.storePromise
    const filter = input.filter ?? {}
    return this.hybridSearch({
      input,
      local: () => store.searchPaperChunks(input.workspacePath, input.query, this.candidateLimit, filter),
      searchVector: vector => this.backend.searchChunks({
        vector, workspaceKey: workspaceKey(input.workspacePath), limit: this.candidateLimit, filter,
      }),
      sourceId: chunkId,
      hydrate: ids => store.getPaperChunkCitationsByIds(input.workspacePath, ids, filter),
      hydratedId: hit => hit.id,
    })
  }

  async searchElements(input: ElementRetrievalInput): Promise<RetrievalResult<PaperElementCitation>> {
    const store = await this.storePromise
    const filter = input.filter ?? {}
    const types = input.types ?? STRUCTURED_PAPER_ELEMENT_TYPES
    return this.hybridSearch({
      input,
      local: () => store.searchPaperElements({
        workspacePath: input.workspacePath, query: input.query, limit: this.candidateLimit,
        types, filter,
      }),
      searchVector: vector => this.backend.searchElements({
        vector, workspaceKey: workspaceKey(input.workspacePath), limit: this.candidateLimit, filter,
        types,
      }),
      sourceId: elementId,
      hydrate: ids => store.getPaperElementCitationsByIds({
        workspacePath: input.workspacePath, elementIds: ids,
        types, filter,
      }),
      hydratedId: hit => hit.id,
    })
  }

  async searchFigures(input: FigureRetrievalInput): Promise<RetrievalResult<PaperFigureCitation>> {
    const store = await this.storePromise
    return this.hybridSearch({
      input,
      local: () => store.searchPaperFigures(input.workspacePath, input.query, this.candidateLimit),
      searchVector: vector => this.backend.searchElements({
        vector, workspaceKey: workspaceKey(input.workspacePath), limit: this.candidateLimit,
        filter: {}, types: ['figure'],
      }),
      sourceId: elementId,
      hydrate: ids => store.getPaperFigureCitationsByElementIds(input.workspacePath, ids),
      hydratedId: hit => hit.elementId,
    })
  }

  private async hybridSearch<Hit extends TraceableHit>(options: {
    readonly input: ChunkRetrievalInput | ElementRetrievalInput | FigureRetrievalInput
    readonly local: () => readonly Hit[]
    readonly searchVector: (vector: readonly number[]) => Promise<readonly VectorCandidate[]>
    readonly sourceId: (sourceId: string) => string | undefined
    readonly hydrate: (ids: readonly string[]) => readonly Hit[]
    readonly hydratedId: (hit: Hit) => string | null | undefined
  }): Promise<RetrievalResult<Hit>> {
    const limit = bounded(options.input.limit ?? 6, 1, 20)
    const sqliteStarted = now()
    const sqlitePromise = Promise.resolve(options.local())
    const embeddingStarted = now()
    let embeddingCompleted = false
    const vectorPromise = this.backend.embedQuery(options.input.query)
      .then(async vector => {
        embeddingCompleted = true
        options.input.trace?.stage({ kind: 'embedding', status: 'completed', durationMs: elapsed(embeddingStarted), candidates: [] })
        const elasticStarted = now()
        const candidates = await options.searchVector(vector)
        return { candidates, durationMs: elapsed(elasticStarted) }
      })

    const sqliteHits = await sqlitePromise
    options.input.trace?.stage(traceStage('sqlite', 'completed', sqliteStarted, sqliteHits, { method: 'fts', sqliteRanks: true }))
    try {
      const vector = await vectorPromise
      const sourceIds = vector.candidates
        .map(candidate => options.sourceId(candidate.sourceId))
        .filter((id): id is string => id !== undefined)
      const hydrationById = new Map(options.hydrate(sourceIds).flatMap(hit => {
        const id = options.hydratedId(hit)
        return id === null || id === undefined ? [] : [[id, hit] as const]
      }))
      const elasticHits = vector.candidates.flatMap(candidate => {
        const id = options.sourceId(candidate.sourceId)
        const hit = id === undefined ? undefined : hydrationById.get(id)
        return hit === undefined ? [] : [{ hit, score: candidate.score }]
      })
      options.input.trace?.stage({
        kind: 'elasticsearch', status: 'completed', durationMs: vector.durationMs, method: 'knn',
        candidates: elasticHits.slice(0, 30).map(({ hit, score }, index) => candidateFor(hit, index + 1, { score, elasticRank: index + 1 })),
      })
      const merged = fuse(sqliteHits, elasticHits, this.rrfK)
      options.input.trace?.stage({
        kind: 'fusion', status: 'completed', durationMs: 0, method: 'rrf',
        candidates: merged.slice(0, 30).map((entry, index) => candidateFor(entry.hit, index + 1, {
          ...(entry.sqliteRank === undefined ? {} : { sqliteRank: entry.sqliteRank }),
          ...(entry.elasticRank === undefined ? {} : { elasticRank: entry.elasticRank }),
          fusionScore: entry.score,
        })),
      })
      const finalEntries = merged.slice(0, limit)
      const hits = finalEntries.map(entry => entry.hit)
      options.input.trace?.stage({
        kind: 'final', status: 'completed', durationMs: 0,
        candidates: finalEntries.map((entry, index) => candidateFor(entry.hit, index + 1, {
          ...(entry.sqliteRank === undefined ? {} : { sqliteRank: entry.sqliteRank }),
          ...(entry.elasticRank === undefined ? {} : { elasticRank: entry.elasticRank }),
          fusionScore: entry.score,
        })),
      })
      return { mode: 'hybrid', hits }
    } catch (error) {
      const reason = safeReason(error)
      options.input.trace?.stage({
        kind: embeddingCompleted ? 'elasticsearch' : 'embedding',
        status: 'fallback', durationMs: elapsed(embeddingStarted), reason, candidates: [],
      })
      options.input.trace?.stage(traceStage('final', 'fallback', now(), sqliteHits.slice(0, limit), { reason, sqliteRanks: true }))
      return { mode: 'sqlite', hits: sqliteHits.slice(0, limit) }
    }
  }
}

type TraceableHit = PaperCitation | PaperElementCitation | PaperFigureCitation

function dedupeHits<Hit extends TraceableHit>(hits: readonly Hit[]): Hit[] {
  const seen = new Set<string>()
  return hits.flatMap(hit => {
    if (seen.has(hit.id)) return []
    seen.add(hit.id)
    return [hit]
  })
}

function fuse<Hit extends TraceableHit>(
  sqliteHits: readonly Hit[],
  elasticHits: readonly { readonly hit: Hit; readonly score: number }[],
  rrfK: number,
): Array<{ readonly hit: Hit; readonly sqliteRank?: number; readonly elasticRank?: number; readonly score: number }> {
  const merged = new Map<string, { hit: Hit; sqliteRank?: number; elasticRank?: number; score: number }>()
  for (const [index, hit] of sqliteHits.entries()) {
    const rank = index + 1
    merged.set(hit.id, { hit, sqliteRank: rank, score: 1 / (rrfK + rank) })
  }
  for (const [index, entry] of elasticHits.entries()) {
    const rank = index + 1
    const current = merged.get(entry.hit.id)
    if (current === undefined) merged.set(entry.hit.id, { hit: entry.hit, elasticRank: rank, score: 1 / (rrfK + rank) })
    else merged.set(entry.hit.id, { ...current, elasticRank: rank, score: current.score + 1 / (rrfK + rank) })
  }
  return [...merged.values()].sort((left, right) => right.score - left.score || left.hit.id.localeCompare(right.hit.id))
}

function suppressFinalTrace(sink: RetrievalTraceSink | undefined): RetrievalTraceSink | undefined {
  if (sink === undefined) return undefined
  return { stage: value => { if (value.kind !== 'final') sink.stage(value) } }
}

function renderChunkForRerank(hit: PaperCitation): string {
  return [
    '[Title]', hit.title,
    '[Section]', hit.section,
    '[Content]', hit.excerpt,
  ].join('\n')
}

function renderElementForRerank(hit: PaperElementCitation): string {
  return [
    '[Title]', hit.title,
    '[Section]', hit.section,
    '[Type]', hit.elementType,
    '[Caption]', hit.caption ?? '',
    '[Content]', hit.content,
  ].join('\n')
}

function renderFigureForRerank(hit: PaperFigureCitation): string {
  return [
    '[Title]', hit.title,
    '[Section]', hit.sectionTitle,
    '[Type]', 'figure',
    '[Caption]', hit.rawCaption,
    '[Nearby text]', hit.nearbyText ?? '',
    '[Vision description]', hit.visionDescription ?? '',
  ].join('\n')
}

function traceStage(
  kind: RetrievalTraceStageKind,
  status: RetrievalTraceStageStatus,
  startedAt: number,
  hits: readonly (PaperCitation | PaperElementCitation | PaperFigureCitation)[],
  details: { readonly method?: 'fts' | 'knn' | 'rrf'; readonly reason?: string; readonly sqliteRanks?: boolean } = {},
): RetrievalTraceStage {
  return {
    kind, status, durationMs: elapsed(startedAt),
    ...(details.method === undefined ? {} : { method: details.method }),
    ...(details.reason === undefined ? {} : { reason: details.reason }),
    candidates: hits.slice(0, 30).map((hit, index) => candidateFor(hit, index + 1,
      details.sqliteRanks ? { sqliteRank: index + 1 } : {})),
  }
}

function candidateFor(
  hit: PaperCitation | PaperElementCitation | PaperFigureCitation,
  rank: number,
  details: { readonly score?: number; readonly sqliteRank?: number; readonly elasticRank?: number; readonly fusionScore?: number; readonly rerankScore?: number } = {},
): RetrievalTraceCandidate {
  const citation = 'sectionTitle' in hit
    ? { sourceId: hit.id, paperId: hit.paperId, title: hit.title, section: hit.sectionTitle, pdfPageStart: hit.pdfPage, excerpt: hit.rawCaption }
    : 'content' in hit
      ? { sourceId: hit.id, paperId: hit.paperId, title: hit.title, section: hit.section, pdfPageStart: hit.pdfPageStart, excerpt: hit.content }
      : { sourceId: hit.id, paperId: hit.paperId, title: hit.title, section: hit.section, pdfPageStart: hit.pdfPageStart ?? 0, excerpt: hit.excerpt }
  return {
    ...citation, rank, excerpt: citation.excerpt.slice(0, 300),
    ...(details.score === undefined ? {} : { score: details.score }),
    ...(details.sqliteRank === undefined ? {} : { sqliteRank: details.sqliteRank }),
    ...(details.elasticRank === undefined ? {} : { elasticRank: details.elasticRank }),
    ...(details.fusionScore === undefined ? {} : { fusionScore: details.fusionScore }),
    ...(details.rerankScore === undefined ? {} : { rerankScore: details.rerankScore }),
  }
}

function workspaceKey(workspacePath: string): string {
  // Must use the same normalized path as the indexing worker. A Session may
  // expose a Windows path with different separator/case spelling, while the
  // persisted vector document always uses the domain's canonical workspace.
  return createHash('sha256').update(canonicalWorkspace(workspacePath)).digest('hex')
}

function chunkId(sourceId: string): string | undefined {
  return projectionId(sourceId, 'chunk:')
}

function elementId(sourceId: string): string | undefined {
  return projectionId(sourceId, 'element:')
}

function projectionId(sourceId: string, prefix: string): string | undefined {
  return sourceId.startsWith(prefix) && sourceId.length > prefix.length
    ? sourceId.slice(prefix.length)
    : undefined
}

function safeReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/(ApiKey|Bearer)\s+[^\s]+/gi, '$1 [redacted]').slice(0, 300)
}

function bounded(value: number, min: number, max: number): number { return Math.min(Math.max(Math.trunc(value), min), max) }
function now(): number { return Date.now() }
function elapsed(startedAt: number): number { return Math.max(0, Date.now() - startedAt) }
