import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PaperAgentStore, paperArtifactPaths } from '../packages/domain/src/index.ts'
import { MineruPrecisionParser } from '../packages/parser-mineru/src/index.ts'

const parserConfig = {
  apiBaseUrl: 'https://mineru.example.test', apiToken: 'unit-test-token', modelVersion: 'vlm' as const,
  enableOcr: false, enableFormula: true, enableTable: true, pollIntervalMs: 1, timeoutMs: 1_000,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paperagent-mineru-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = await PaperAgentStore.open({ databasePath: join(root, 'domain.sqlite'), maxPdfBytes: 1024 * 1024 })
  const source = join(root, 'article.pdf')
  await writeFile(source, '%PDF-1.4\nunit test\n')
  const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: source })).paper
  return { root, workspace, store, paper }
}

test('MinerU precision parser uploads, polls, and writes citeable local artifacts', async () => {
  const { root, workspace, store, paper } = await fixture()
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  let tokenResolutions = 0
  try {
    const archive = storedZip({
      'result/full.md': '# Example Paper\n\n## 1 Introduction\n\nMinerU preserves two-column reading order.\n',
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: '1 Introduction' }], level: 1 }, bbox: [80, 100, 900, 150] },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'MinerU preserves two-column reading order.' }] }, bbox: [80, 160, 900, 240] },
        { type: 'page_footer', content: { page_footer_content: [{ type: 'text', content: '1' }] }, bbox: [80, 950, 900, 980] },
      ]]),
    })
    const parser = new MineruPrecisionParser({
      config: parserConfig,
      resolveApiToken: async () => {
        tokenResolutions += 1
        return 'unit-test-token'
      },
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.endsWith('/api/v4/file-urls/batch')) {
          assert.equal(init?.headers instanceof Headers ? init.headers.get('Authorization') : (init?.headers as Record<string, string>).Authorization, 'Bearer unit-test-token')
          return json({ code: 0, data: { batch_id: 'batch-1', file_urls: ['https://upload.example.test/file'] } })
        }
        if (url === 'https://upload.example.test/file') return new Response(null, { status: 200 })
        if (url.endsWith('/api/v4/extract-results/batch/batch-1')) {
          return json({ code: 0, trace_id: 'trace-1', data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.example.test/result.zip' }] } })
        }
        if (url === 'https://download.example.test/result.zip') return binaryResponse(archive)
        throw new Error(`unexpected request: ${url}`)
      },
    })

    const artifact = await parser.parse(store, workspace, paper.id)
    assert.equal(artifact.paper.parseStatus, 'ready')
    assert.equal(artifact.chunkCount, 1)
    assert.equal(requests.length, 4)
    assert.equal(tokenResolutions, 1)
    const createRequest = requests.find(request => request.url.endsWith('/api/v4/file-urls/batch'))
    if (createRequest === undefined) assert.fail('expected a MinerU create-upload request')
    assert.deepEqual(JSON.parse(String(createRequest.init?.body)), {
      files: [{ name: 'article.pdf', data_id: paper.id, is_ocr: false }],
      model_version: 'vlm', enable_formula: true, enable_table: true,
    })
    const pollRequest = requests.find(request => request.url.endsWith('/api/v4/extract-results/batch/batch-1'))
    if (pollRequest === undefined) assert.fail('expected a MinerU polling request')
    assert.equal(authorization(pollRequest.init), 'Bearer unit-test-token')
    const revisionPaths = paperArtifactPaths(artifact.paper)
    assert.match(await readFile(revisionPaths.markdown, 'utf8'), /two-column reading order/)
    const sourceMap = JSON.parse(await readFile(revisionPaths.sourceMap, 'utf8')) as { version: number; sections: Array<{ title: string; level: number; parentId: string | null; lineStart: number }>; chunks: Array<{ section: string; sectionId: string; chunkType: string; pdfPageStart: number; elementIds: string[]; lineStart: number }>; elements: Array<{ elementType: string; section: string; pdfPageStart: number }> }
    assert.equal(sourceMap.version, 5)
    assert.equal('bbox' in (sourceMap.chunks[0] ?? {}), false)
    assert.equal(sourceMap.chunks[0]?.section, 'Document > 1 Introduction')
    assert.equal(sourceMap.chunks[0]?.chunkType, 'child')
    assert.equal(sourceMap.sections.find(section => section.title === '1 Introduction')?.level, 1)
    assert.equal(sourceMap.sections.find(section => section.title === '1 Introduction')?.lineStart, 3)
    assert.equal(sourceMap.chunks[0]?.lineStart, 5)
    assert.equal(sourceMap.chunks[0]?.pdfPageStart, 1)
    assert.equal(sourceMap.chunks[0]?.elementIds.length, 0)
    assert.equal(sourceMap.elements.length, 0)
    assert.equal(artifact.elementCount, sourceMap.elements.length)
    assert.equal(store.searchPaperChunks(workspace, 'two-column').length, 1)
    await assert.rejects(readFile(paperArtifactPaths(artifact.paper, null).markdown))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser ignores standalone title-page author metadata', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const archive = storedZip({
      'result/full.md': '# Example Paper\n\nAda Lovelace, Charles Babbage\n\nDepartment of Computing, Example University\n\n## Abstract\n\nThis abstract remains searchable.\n\n## 1 Introduction\n\nThe introduction remains searchable too.\n',
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Example Paper' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'Ada Lovelace, Charles Babbage' }] } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'Department of Computing, Example University' }] } },
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Abstract' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'This abstract remains searchable.' }] } },
        { type: 'title', content: { title_content: [{ type: 'text', content: '1 Introduction' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'The introduction remains searchable too.' }] } },
      ]]),
    })
    await completedParser(archive).parse(store, workspace, paper.id)
    assert.equal(store.searchPaperChunks(workspace, 'Ada Lovelace').length, 0)
    assert.equal(store.searchPaperChunks(workspace, 'Department Computing').length, 0)
    assert.equal(store.searchPaperChunks(workspace, 'abstract remains searchable').length, 1)
    assert.equal(store.searchPaperChunks(workspace, 'introduction remains searchable').length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser merges a tiny trailing chunk within its section', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const longParagraph = `A ${'stable '.repeat(210)}paragraph.`
    const shortTail = 'This is the short tail sentence.'
    const archive = storedZip({
      'result/full.md': `# Example Paper\n\n## 1 Introduction\n\n${longParagraph}\n\n${shortTail}\n`,
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Example Paper' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: '1 Introduction' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: longParagraph }] } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: shortTail }] } },
      ]]),
    })
    const artifact = await completedParser(archive).parse(store, workspace, paper.id)
    assert.equal(artifact.chunkCount, 1)
    assert.equal(store.searchPaperChunks(workspace, 'short tail sentence').length, 1)
    const sourceMap = JSON.parse(await readFile(paperArtifactPaths(artifact.paper).sourceMap, 'utf8')) as { chunks: Array<{ lineEnd: number }> }
    assert.equal(sourceMap.chunks.length, 1)
    assert.equal(sourceMap.chunks[0]?.lineEnd, 8)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser stores table and equation bodies as typed elements', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const archive = storedZip({
      'result/full.md': '# Method\\n\\n| Model | Score |\\n| --- | --- |\\n| Ours | 92 |\\n\\nE = mc^2\\n',
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Method' }], level: 1 } },
        { type: 'table', content: { table_caption: [{ type: 'text', content: 'Table 1. Scores' }], table_body: [{ type: 'text', content: '| Model | Score |\\n| --- | --- |\\n| Ours | 92 |' }], table_footnote: [{ type: 'text', content: 'Higher is better.' }] }, bbox: [20, 100, 500, 300] },
        { type: 'equation', content: { math_content: [{ type: 'text', content: 'E = mc^2' }] }, bbox: [20, 320, 500, 360] },
      ]]),
    })
    const artifact = await completedParser(archive).parse(store, workspace, paper.id)
    assert.equal(artifact.elementCount, 2)
    const table = store.searchPaperElements({ workspacePath: workspace, query: 'Higher better', types: ['table'] })[0]
    if (table === undefined) assert.fail('expected a table element')
    assert.match(table.content, /Ours \\| 92/)
    const equation = store.searchPaperElements({ workspacePath: workspace, query: 'mc^2', types: ['equation'] })[0]
    if (equation === undefined) assert.fail('expected an equation element')
    assert.equal(equation.content, 'E = mc^2')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser infers semantic section nesting from numbered headings', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const archive = storedZip({
      'result/full.md': '# Example Paper\n\n## 3 Method\n\n## 3.3 Hierarchical Routing\n\n## 3.3.1 Scene Routing\n\nA paragraph with a stable Markdown location.\n\n## II. RELATED WORK\n\n## C. Vehicle Detection\n\nAnother paragraph.\n',
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Example Paper' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: '3 Method' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: '3.3 Hierarchical Routing' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: '3.3.1 Scene Routing' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'A paragraph with a stable Markdown location.' }] } },
        { type: 'title', content: { title_content: [{ type: 'text', content: 'II. RELATED WORK' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: 'C. Vehicle Detection' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'Another paragraph.' }] } },
      ]]),
    })
    const artifact = await completedParser(archive).parse(store, workspace, paper.id)
    const sourceMap = JSON.parse(await readFile(paperArtifactPaths(artifact.paper).sourceMap, 'utf8')) as {
      sections: Array<{ id: string; title: string; level: number; parentId: string | null; path: string; lineStart: number }>
      chunks: Array<{ lineStart: number; section: string }>
    }
    const byTitle = new Map(sourceMap.sections.map(section => [section.title, section]))
    const title = byTitle.get('Example Paper')
    const method = byTitle.get('3 Method')
    const routing = byTitle.get('3.3 Hierarchical Routing')
    const scene = byTitle.get('3.3.1 Scene Routing')
    const related = byTitle.get('II. RELATED WORK')
    const vehicle = byTitle.get('C. Vehicle Detection')
    assert.ok(title && method && routing && scene && related && vehicle)
    assert.deepEqual([title.level, method.level, routing.level, scene.level], [1, 2, 3, 4])
    assert.equal(method.parentId, title.id)
    assert.equal(routing.parentId, method.id)
    assert.equal(scene.parentId, routing.id)
    assert.equal(related.level, 2)
    assert.equal(vehicle.level, 3)
    assert.equal(vehicle.parentId, related.id)
    assert.deepEqual([title.lineStart, method.lineStart, routing.lineStart, scene.lineStart], [1, 3, 5, 7])
    assert.equal(sourceMap.chunks[0]?.lineStart, 9)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser creates a References boundary when MinerU omits the heading', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const archive = storedZip({
      'result/full.md': '# Example Paper\n\n## VI. CONCLUSION\n\nThe conclusion.\n\n[1] A. Author, “A cited work,” 2022.\n\n[2] B. Author, “Another cited work,” 2021.\n',
      'result/article_content_list_v2.json': JSON.stringify([[
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Example Paper' }], level: 1 } },
        { type: 'title', content: { title_content: [{ type: 'text', content: 'VI. CONCLUSION' }], level: 1 } },
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'The conclusion.' }] } },
        { type: 'list', content: { list_items: [{ type: 'text', content: '[1] A. Author, “A cited work,” 2022.' }] } },
        { type: 'list', content: { list_items: [{ type: 'text', content: '[2] B. Author, “Another cited work,” 2021.' }] } },
      ]]),
    })
    const artifact = await completedParser(archive).parse(store, workspace, paper.id)
    const outline = store.listPaperSections(workspace, paper.id)
    const references = outline.find(section => section.title === 'References')
    assert.ok(references)
    assert.match(references.path, /References$/u)
    const entries = store.searchPaperElements({ workspacePath: workspace, query: 'cited work', types: ['list'] })
    assert.equal(entries.length, 2)
    assert.ok(entries.every(entry => entry.section.endsWith('References')))
    const referenceRecords = store.listPaperReferences(workspace, paper.id)
    assert.equal(referenceRecords.length, 2)
    assert.equal(referenceRecords[0]?.ordinal, 1)
    assert.equal(referenceRecords[0]?.year, 2022)
    assert.equal(store.getPaperReference(workspace, paper.id, 2).title, 'Another cited work')
    assert.equal(artifact.elementCount, 2)
    assert.equal(artifact.referenceCount, 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser extracts only content-list-referenced figure assets into the paper images directory', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const archive = storedZip({
      'result/full.md': '# Example\n\n## Results\n\nFigure 1 compares attention weights.\n',
      'result/article_content_list_v2.json': JSON.stringify([[ 
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Results' }], level: 1 } },
        { type: 'image', content: { image_path: 'images/attention.png', image_caption: [{ type: 'text', content: 'Figure 1. Attention comparison.' }] } },
      ]]),
      'result/images/attention.png': image,
      'result/images/unreferenced.png': new Uint8Array([1, 2, 3]),
    })
    const parser = completedParser(archive)
    const artifact = await parser.parse(store, workspace, paper.id)

    const figures = store.listPaperFigures(workspace, paper.id)
    assert.equal(figures.length, 1)
    assert.ok(figures[0]?.elementId)
    assert.equal(figures[0]?.figureLabel, 'Figure 1')
    assert.equal(figures[0]?.sectionTitle, 'Results')
    assert.equal(figures[0]?.pageNumber, 1)
    assert.match(figures[0]?.rawCaption ?? '', /Attention comparison/)
    const elementHits = store.searchPaperElements({ workspacePath: workspace, query: 'attention comparison', types: ['figure'] })
    assert.equal(elementHits.length, 1)
    assert.equal(elementHits[0]?.elementType, 'figure')
    assert.deepEqual(await readFile(paperArtifactPaths(artifact.paper).images + '/figure-001.png'), Buffer.from(image))
    await assert.rejects(readFile(paperArtifactPaths(artifact.paper).images + '/unreferenced.png'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser falls back to Markdown image references when content-list image paths are absent', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const archive = storedZip({
      'result/full.md': '# Example\n\n## Results\n\n![](images/attention.png)\nFig. 1. Attention comparison.\n',
      'result/article_content_list_v2.json': JSON.stringify([[], [
        { type: 'title', content: { title_content: [{ type: 'text', content: 'Results' }], level: 1 } },
        { type: 'image', content: { image_caption: [{ type: 'text', content: 'Fig. 1. Attention comparison.' }] } },
      ]]),
      'result/images/attention.png': image,
    })
    const parser = completedParser(archive)
    const artifact = await parser.parse(store, workspace, paper.id)

    const figures = store.listPaperFigures(workspace, paper.id)
    assert.equal(figures.length, 1)
    assert.equal(figures[0]?.figureLabel, 'Fig. 1')
    assert.equal(figures[0]?.sectionTitle, 'Results')
    assert.equal(figures[0]?.pageNumber, 2)
    assert.match(figures[0]?.rawCaption ?? '', /Attention comparison/)
    assert.deepEqual(await readFile(paperArtifactPaths(artifact.paper).images + '/figure-001.png'), Buffer.from(image))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser rejects unsafe result archives and retains no partial artifacts', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const parser = new MineruPrecisionParser({
      config: parserConfig,
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/v4/file-urls/batch')) return json({ code: 0, data: { batch_id: 'batch-2', file_urls: ['https://upload.example.test/file'] } })
        if (url === 'https://upload.example.test/file') return new Response(null, { status: 200 })
        if (url.endsWith('/api/v4/extract-results/batch/batch-2')) return json({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.example.test/unsafe.zip' }] } })
        if (url === 'https://download.example.test/unsafe.zip') return binaryResponse(storedZip({ '../escape.md': 'unsafe' }))
        throw new Error(`unexpected request: ${url}`)
      },
    })
    await assert.rejects(parser.parse(store, workspace, paper.id), /unsafe path/)
    assert.equal(store.getPaper(workspace, paper.id).parseStatus, 'failed')
    await assert.rejects(readFile(paperArtifactPaths(paper).markdown))
    await assert.rejects(readFile(paperArtifactPaths(paper).sourceMap))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser gives actionable authentication failures without exposing a token', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const parser = new MineruPrecisionParser({
      config: parserConfig,
      resolveApiToken: async () => 'Bearer should-not-be-sent',
      fetch: async () => { throw new Error('the invalid token must be rejected before any request') },
    })
    await assert.rejects(parser.parse(store, workspace, paper.id), /must not include the Bearer prefix/)

    const unauthorized = new MineruPrecisionParser({
      config: parserConfig,
      fetch: async () => new Response(JSON.stringify({ msg: 'invalid API token', trace_id: 'trace-auth-1' }), { status: 401 }),
    })
    await assert.rejects(unauthorized.parse(store, workspace, paper.id), /HTTP 401: invalid API token \(MinerU trace_id: trace-auth-1\)/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser identifies the failed network stage and preserves its low-level cause', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const fetchFailure = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
    })
    const parser = new MineruPrecisionParser({
      config: parserConfig,
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/api/v4/file-urls/batch')) return json({ code: 0, data: { batch_id: 'batch-network', file_urls: ['https://signed.example.test/result?secret=redacted'] } })
        if (url === 'https://signed.example.test/result?secret=redacted') throw fetchFailure
        throw new Error(`unexpected request: ${url}`)
      },
    })
    await assert.rejects(parser.parse(store, workspace, paper.id), /upload PDF to MinerU network request failed: fetch failed; socket timed out; ETIMEDOUT/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('MinerU precision parser restores the previous artifact pair when chunk persistence fails', async () => {
  const { root, workspace, store, paper } = await fixture()
  try {
    const archive = storedZip({
      'result/full.md': '# Stable result\n\nMinerU source text.\n',
      'result/content_list_v2.json': JSON.stringify([[
        { type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'MinerU source text.' }] }, bbox: [10, 10, 900, 90] },
      ]]),
    })
    const parser = completedParser(archive)
    const firstArtifact = await parser.parse(store, workspace, paper.id)
    const firstRevisionPaths = paperArtifactPaths(firstArtifact.paper)
    const beforeMarkdown = await readFile(firstRevisionPaths.markdown, 'utf8')
    const beforeSourceMap = await readFile(firstRevisionPaths.sourceMap, 'utf8')
    const originalReplace = store.replacePaperChunks.bind(store)
    ;(store as unknown as { replacePaperChunks: () => void }).replacePaperChunks = () => { throw new Error('simulated SQLite chunk failure') }

    await assert.rejects(parser.parse(store, workspace, paper.id), /simulated SQLite chunk failure/)
    assert.equal(await readFile(firstRevisionPaths.markdown, 'utf8'), beforeMarkdown)
    assert.equal(await readFile(firstRevisionPaths.sourceMap, 'utf8'), beforeSourceMap)
    assert.equal(store.getPaper(workspace, paper.id).parseStatus, 'failed')
    ;(store as unknown as { replacePaperChunks: typeof originalReplace }).replacePaperChunks = originalReplace
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }) }

function authorization(init: RequestInit | undefined): string | null | undefined {
  const headers = init?.headers
  return headers instanceof Headers ? headers.get('Authorization') : (headers as Record<string, string> | undefined)?.Authorization
}

function completedParser(archive: Uint8Array): MineruPrecisionParser {
  return new MineruPrecisionParser({
    config: parserConfig,
    fetch: async input => {
      const url = String(input)
      if (url.endsWith('/api/v4/file-urls/batch')) return json({ code: 0, data: { batch_id: 'stable-batch', file_urls: ['https://upload.example.test/stable-file'] } })
      if (url === 'https://upload.example.test/stable-file') return new Response(null, { status: 200 })
      if (url.endsWith('/api/v4/extract-results/batch/stable-batch')) return json({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.example.test/stable.zip' }] } })
      if (url === 'https://download.example.test/stable.zip') return binaryResponse(archive)
      throw new Error(`unexpected request: ${url}`)
    },
  })
}

function binaryResponse(bytes: Uint8Array): Response {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Response(copy.buffer, { status: 200 })
}

/** Writes an uncompressed ZIP fixture; production additionally supports deflate entries. */
function storedZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const contentBytes = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(0, 14); local.writeUInt32LE(contentBytes.length, 18); local.writeUInt32LE(contentBytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, contentBytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(0, 16); directory.writeUInt32LE(contentBytes.length, 20); directory.writeUInt32LE(contentBytes.length, 24)
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42)
    central.push(directory, nameBytes)
    offset += local.length + nameBytes.length + contentBytes.length
  }
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0)
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(Object.keys(entries).length, 8); footer.writeUInt16LE(Object.keys(entries).length, 10)
  footer.writeUInt32LE(centralSize, 12); footer.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, ...central, footer])
}
