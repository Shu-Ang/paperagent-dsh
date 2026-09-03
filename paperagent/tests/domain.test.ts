import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PaperAgentStore, workspaceDataPath } from '../packages/domain/src/index.ts'

async function fixture(): Promise<{ root: string; store: PaperAgentStore }> {
  const root = await mkdtemp(join(tmpdir(), 'paperagent-domain-'))
  const store = await PaperAgentStore.open({ databasePath: join(root, 'domain.sqlite'), maxPdfBytes: 1024 * 1024 })
  return { root, store }
}

test('imports one local PDF once and scopes libraries to its workspace', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'source.pdf')
    await writeFile(source, '%PDF-1.4\nexample')
    await writeFile(join(root, 'workspace.marker'), '')
    await mkdir(workspace)

    const library = store.createLibrary({ workspacePath: workspace, name: 'Foundations' })
    const first = await store.importPaper({ workspacePath: workspace, libraryId: library.id, sourcePath: source, title: 'Example' })
    const second = await store.importPaper({ workspacePath: workspace, libraryId: library.id, sourcePath: source, title: 'Different title' })

    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal(second.paper.id, first.paper.id)
    assert.deepEqual(store.listLibraries(workspace).map(item => item.name), ['Foundations'])
    assert.equal(store.listPapers(workspace).length, 1)
    assert.equal(first.paper.parseStatus, 'queued')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('uses the original browser filename as the default title instead of its temporary upload path', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const temporaryUpload = join(root, 'uploads', '9d33c21e-89c9-4ad0-b7ef.pdf')
    await mkdir(workspace)
    await mkdir(join(root, 'uploads'))
    await writeFile(temporaryUpload, '%PDF-1.4\nexample')

    const imported = await store.importPaper({
      workspacePath: workspace, sourcePath: temporaryUpload, originalFileName: 'Attention Is All You Need.pdf',
    })
    assert.equal(imported.paper.title, 'Attention Is All You Need')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects paths that escape a workspace PaperAgent directory', () => {
  assert.throws(() => workspaceDataPath('D:/research/project', '../outside.pdf'), /escapes/)
})

test('deleting a library keeps its papers as unclassified local records', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const library = store.createLibrary({ workspacePath: workspace, name: 'To remove' })
    const imported = await store.importPaper({ workspacePath: workspace, libraryId: library.id, sourcePath: source })

    store.deleteLibrary(workspace, library.id)

    assert.deepEqual(store.listLibraries(workspace), [])
    assert.equal(store.getPaper(workspace, imported.paper.id).libraryId, null)
    assert.equal(store.listPapers(workspace).length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('moving a paper changes only its library classification', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const sourceLibrary = store.createLibrary({ workspacePath: workspace, name: 'Source' })
    const targetLibrary = store.createLibrary({ workspacePath: workspace, name: 'Target' })
    const imported = await store.importPaper({ workspacePath: workspace, libraryId: sourceLibrary.id, sourcePath: source })

    const moved = store.movePaper({ workspacePath: workspace, paperId: imported.paper.id, libraryId: targetLibrary.id })
    assert.equal(moved.libraryId, targetLibrary.id)
    assert.equal(moved.relativeDir, imported.paper.relativeDir)
    assert.equal(store.listPapers(workspace, sourceLibrary.id).length, 0)
    assert.equal(store.listPapers(workspace, targetLibrary.id)[0]?.id, imported.paper.id)

    const unclassified = store.movePaper({ workspacePath: workspace, paperId: imported.paper.id, libraryId: null })
    assert.equal(unclassified.libraryId, null)
    assert.equal(store.listPapers(workspace, null)[0]?.id, imported.paper.id)
    assert.throws(() => store.movePaper({ workspacePath: workspace, paperId: imported.paper.id, libraryId: 'outside-library' }), /library not found/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('renames libraries, tracks paper counts, and distinguishes unclassified papers', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const library = store.createLibrary({ workspacePath: workspace, name: 'Initial name' })
    const imported = await store.importPaper({ workspacePath: workspace, libraryId: library.id, sourcePath: source })

    const renamed = store.renameLibrary(workspace, library.id, 'Renamed library')
    assert.equal(renamed.name, 'Renamed library')
    assert.equal(renamed.paperCount, 1)

    store.deleteLibrary(workspace, library.id)
    assert.equal(store.listPapers(workspace, null)[0]?.id, imported.paper.id)
    assert.equal(store.listPapers(workspace, undefined)[0]?.id, imported.paper.id)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('updates paper metadata and deletes only its own artifacts', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'Before' })
    await writeFile(workspaceDataPath(workspace, `${imported.paper.relativeDir}/paper.md`), '# Parsed')
    const updated = store.updatePaperMetadata({
      workspacePath: workspace,
      paperId: imported.paper.id,
      patch: { title: 'After', authors: ['Ada Lovelace', 'Grace Hopper'], year: 2026, doi: '10.1/example', journal: 'Local Systems' },
    })
    assert.equal(updated.title, 'After')
    assert.deepEqual(updated.authors, ['Ada Lovelace', 'Grace Hopper'])
    assert.equal(updated.journal, 'Local Systems')

    await store.deletePaper(workspace, imported.paper.id)
    assert.throws(() => store.getPaper(workspace, imported.paper.id), /paper not found/)
    await assert.rejects(() => readFile(workspaceDataPath(workspace, imported.paper.relativeDir)), /ENOENT/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('replaces BibTeX and derives metadata unless an explicit edit overrides it', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'Untitled PDF' })
    const bibtex = `@inproceedings{ijcai2024p84,
      title = {CF-Deformable DETR: An End-to-End Alignment-Free Model},
      author = {Fu, Haolong and Yuan, Jin},
      booktitle = {Proceedings of {IJCAI-24}},
      pages = {758--766},
      year = {2024},
      doi = {10.24963/ijcai.2024/84},
      url = {https://doi.org/10.24963/ijcai.2024/84}
    }`

    const fromBibtex = store.updatePaperMetadata({
      workspacePath: workspace, paperId: imported.paper.id, patch: { bibtex },
    })
    assert.equal(fromBibtex.title, 'CF-Deformable DETR: An End-to-End Alignment-Free Model')
    assert.deepEqual(fromBibtex.authors, ['Fu, Haolong', 'Yuan, Jin'])
    assert.equal(fromBibtex.year, 2024)
    assert.equal(fromBibtex.journal, 'Proceedings of IJCAI-24')
    assert.equal(fromBibtex.doi, '10.24963/ijcai.2024/84')
    assert.equal(fromBibtex.citationKey, 'ijcai2024p84')

    const manualTitle = store.updatePaperMetadata({
      workspacePath: workspace, paperId: imported.paper.id, patch: { bibtex, title: 'My corrected title' },
    })
    assert.equal(manualTitle.title, 'My corrected title')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('reads validated bibliography only from the active workspace and reports unsafe entries', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const otherWorkspace = join(root, 'other-workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await mkdir(otherWorkspace)
    await writeFile(source, '%PDF-1.4\nexample')

    const ready = store.createPaperFromBibtex({
      workspacePath: workspace,
      bibtex: '@article{local2026, title={Local Research}, author={Lovelace, Ada}, year={2026}, doi={10.1000/local}}',
    }).paper
    const missingBibtex = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'PDF without bibliography' })
    const invalidBibtex = store.createPaperFromBibtex({
      workspacePath: workspace,
      bibtex: '@article{placeholder, title={Temporary}}',
    }).paper
    store.updatePaperMetadata({ workspacePath: workspace, paperId: invalidBibtex.id, patch: { bibtex: 'not a BibTeX entry' } })
    const foreign = store.createPaperFromBibtex({
      workspacePath: otherWorkspace,
      bibtex: '@article{foreign2026, title={Foreign}, author={Hopper, Grace}, year={2026}}',
    }).paper

    const entries = store.readPaperBibliography(workspace, [ready.id, missingBibtex.paper.id, invalidBibtex.id, ready.id])
    assert.deepEqual(entries.map(entry => entry.paperId), [ready.id, missingBibtex.paper.id, invalidBibtex.id])
    assert.equal(entries[0]?.metadataStatus, 'ready')
    assert.equal(entries[0]?.citationKey, 'local2026')
    assert.match(entries[0]?.bibtex ?? '', /^@article\{local2026,/)
    assert.equal(entries[1]?.metadataStatus, 'missing-bibtex')
    assert.equal(entries[2]?.metadataStatus, 'invalid-bibtex')

    assert.throws(() => store.readPaperBibliography(workspace, [foreign.id]), /active workspace/)
    assert.throws(() => store.readPaperBibliography(workspace, []), /at least one paper id/)
    assert.throws(() => store.readPaperBibliography(workspace, Array.from({ length: 21 }, (_, index) => `paper-${index}`)), /at most 20/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('creates a metadata-only paper from BibTeX and can attach a PDF later', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const bibtex = '@article{lovelace2026, title={Local First Research}, author={Lovelace, Ada and Hopper, Grace}, year={2026}, journal={Journal of Local Systems}, doi={10.1000/local}}'

    const created = store.createPaperFromBibtex({ workspacePath: workspace, bibtex })
    assert.equal(created.duplicate, false)
    assert.equal(created.paper.title, 'Local First Research')
    assert.deepEqual(created.paper.authors, ['Lovelace, Ada', 'Hopper, Grace'])
    assert.equal(created.paper.parseStatus, 'metadata')
    assert.equal(created.paper.originalFileName, '')

    const attached = await store.replacePaperPdf({ workspacePath: workspace, paperId: created.paper.id, sourcePath: source })
    assert.equal(attached.parseStatus, 'queued')
    assert.equal(attached.originalFileName, 'article.pdf')
    assert.equal((await readFile(workspaceDataPath(workspace, `${attached.relativeDir}/original.pdf`), 'utf8')).startsWith('%PDF-1.4'), true)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('persists import provenance independently from editable bibliography metadata', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'Imported' })

    const saved = store.setPaperImportProvenance({
      workspacePath: workspace,
      paperId: imported.paper.id,
      pdfSourceUrl: 'https://arxiv.org/pdf/2401.01234.pdf',
      bibtexSourceUrl: 'https://arxiv.org/abs/2401.01234',
      sourceAdapter: 'arXiv',
      metadataProvenance: [{ source: 'arXiv Atom API', url: 'https://export.arxiv.org/api/query?id_list=2401.01234' }],
    })
    const updated = store.updatePaperMetadata({ workspacePath: workspace, paperId: saved.id, patch: { title: 'Edited title' } })

    assert.equal(updated.sourceAdapter, 'arXiv')
    assert.equal(updated.pdfSourceUrl, 'https://arxiv.org/pdf/2401.01234.pdf')
    assert.deepEqual(updated.metadataProvenance, [{ source: 'arXiv Atom API', url: 'https://export.arxiv.org/api/query?id_list=2401.01234' }])
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps FTS/lexical paper retrieval, exact Markdown search, and figures scoped to one ready paper', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const library = store.createLibrary({ workspacePath: workspace, name: 'Vision' })
    const imported = await store.importPaper({ workspacePath: workspace, libraryId: library.id, sourcePath: source, title: 'Attention Study' })
    const paper = store.setParseStatus(workspace, imported.paper.id, 'ready')
    await writeFile(workspaceDataPath(workspace, `${paper.relativeDir}/paper.md`), '# Introduction\n\nThe transformer attention mechanism improves results.\n\n图像检索说明。\n\n## 3. MS-DETR\n\nMethod detail.\n\nSource-map-only exact match.\n')
    await writeFile(workspaceDataPath(workspace, `${paper.relativeDir}/source-map.json`), JSON.stringify({ chunks: [
      { section: 'Figure notes', pdfPageStart: 3, pdfPageEnd: 3, lineStart: 11, lineEnd: 11 },
    ] }))
    const now = new Date().toISOString()
    store.replacePaperChunks(workspace, paper.id, [{
      id: 'chunk-1', paperId: paper.id, workspacePath: workspace, section: 'Introduction',
      pdfPageStart: 2, pdfPageEnd: 2, lineStart: 3, lineEnd: 3,
      content: 'The transformer attention mechanism improves results. 图像检索说明。', createdAt: now,
    }, {
      id: 'chunk-2', paperId: paper.id, workspacePath: workspace, section: '3. MS-DETR',
      pdfPageStart: 4, pdfPageEnd: 4, lineStart: 9, lineEnd: 9,
      content: 'Method detail.', createdAt: now,
    }])
    const textHits = store.searchPaperChunks(workspace, 'transformer attention', 6, { libraryId: library.id, section: 'Introduction' })
    assert.equal(textHits.length, 1)
    assert.equal(textHits[0]?.pdfPageStart, 2)
    const exactHits = await store.findInPaperMarkdown({ workspacePath: workspace, paperId: paper.id, query: 'attention mechanism' })
    assert.equal(exactHits[0]?.lineStart, 3)
    const regexHits = await store.findInPaperMarkdown({ workspacePath: workspace, paperId: paper.id, query: 'attention\\s+mechanism', mode: 'regex' })
    assert.equal(regexHits.length, 1)
    const mappedHits = await store.findInPaperMarkdown({ workspacePath: workspace, paperId: paper.id, query: 'Source-map-only' })
    assert.equal(mappedHits[0]?.section, 'Figure notes')
    assert.equal(mappedHits[0]?.pdfPageStart, 3)
    const sectionRead = await store.readPaperSection({ workspacePath: workspace, paperId: paper.id, section: 'Introduction', maxChars: 1_000 })
    assert.equal(sectionRead.citation.section, 'Introduction')
    assert.equal(sectionRead.citation.pdfPageStart, 2)
    assert.match(sectionRead.content, /attention mechanism/)
    const normalizedSectionRead = await store.readPaperSection({ workspacePath: workspace, paperId: paper.id, section: '  introduction  ', maxChars: 1_000 })
    assert.equal(normalizedSectionRead.citation.section, 'Introduction')
    const numberedSectionRead = await store.readPaperSection({ workspacePath: workspace, paperId: paper.id, section: '3. Approach', maxChars: 1_000 })
    assert.equal(numberedSectionRead.citation.section, '3. MS-DETR')
    assert.match(numberedSectionRead.content, /Method detail/)
    assert.deepEqual(store.listPaperSections(workspace, paper.id), [
      { title: 'Introduction', level: 1, pdfPageStart: 2, pdfPageEnd: 2, lineStart: 3, lineEnd: 3 },
      { title: '3. MS-DETR', level: 1, pdfPageStart: 4, pdfPageEnd: 4, lineStart: 9, lineEnd: 9 },
    ])
    const lineRead = await store.readPaperSection({ workspacePath: workspace, paperId: paper.id, lineStart: 1, lineEnd: 3, maxChars: 256 })
    assert.equal(lineRead.citation.lineStart, 1)
    assert.equal(lineRead.truncated, false)
    await assert.rejects(
      store.readPaperSection({ workspacePath: workspace, paperId: paper.id, section: 'Introduction', lineStart: 1, lineEnd: 2 }),
      /either a section or both line bounds/,
    )
    await assert.rejects(
      store.readPaperSection({ workspacePath: workspace, paperId: paper.id, section: 'Not a section' }),
      /Available sections: "Introduction"/,
    )
    await assert.rejects(
      store.findInPaperMarkdown({ workspacePath: workspace, paperId: paper.id, query: '(a+)+$', mode: 'regex' }),
      /nested quantifiers/,
    )
    await mkdir(workspaceDataPath(workspace, `${paper.relativeDir}/images`))
    await writeFile(workspaceDataPath(workspace, `${paper.relativeDir}/images/figure-001.png`), Buffer.from([137, 80, 78, 71]))
    const [figure] = store.replacePaperFigures(workspace, paper.id, [{
      paperId: paper.id, workspacePath: workspace, figureLabel: 'Figure 1', pageNumber: 2, sectionTitle: 'Introduction',
      relativePath: 'images/figure-001.png', mimeType: 'image/png', sha256: 'same-image', rawCaption: 'Attention comparison', nearbyText: 'Transformer attention mechanism.',
    }])
    if (figure === undefined) assert.fail('expected one figure')
    store.setPaperFigureVisionStatus(workspace, figure.id, 'ready', { description: 'A comparison plot of attention weights.', model: 'test', promptVersion: 'test' })
    const figureHits = store.searchPaperFigures(workspace, 'attention weights')
    assert.equal(figureHits.length, 1)
    assert.equal(figureHits[0]?.pdfPage, 2)
    assert.equal(store.findReusableFigureVision(workspace, 'same-image', figure.id), undefined)
    await store.deletePaper(workspace, paper.id)
    assert.equal(store.searchPaperFigures(workspace, 'attention weights').length, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('recalls adjacent CJK phrases through the FTS-compatible index text', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source })
    const paper = store.setParseStatus(workspace, imported.paper.id, 'ready')
    store.replacePaperChunks(workspace, paper.id, [{
      id: 'cjk-chunk', paperId: paper.id, workspacePath: workspace, section: 'Document',
      pdfPageStart: 1, pdfPageEnd: 1, lineStart: 1, lineEnd: 1,
      content: '\u4e2d\u6587\u77ed\u8bed\u68c0\u7d22\u5e94\u5f53\u547d\u4e2d\u8bba\u6587\u7247\u6bb5\u3002', createdAt: new Date().toISOString(),
    }])
    assert.equal(store.searchPaperChunks(workspace, '\u77ed\u8bed\u68c0\u7d22').length, 1)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('indexes and reads structured paper elements independently from text chunks', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'Structured Elements' })
    store.setParseStatus(workspace, imported.paper.id, 'ready')
    const now = new Date().toISOString()
    store.replacePaperChunks(workspace, imported.paper.id, [], [{
      id: 'element-table-test', paperId: imported.paper.id, workspacePath: workspace, elementType: 'table', section: 'Results',
      pdfPageStart: 4, pdfPageEnd: 4, lineStart: 20, lineEnd: 24, readingOrder: 1,
      content: '| Model | Accuracy |\\n| --- | --- |\\n| Ours | 92.1 |', caption: 'Table 1. Accuracy comparison', contentFormat: 'markdown', createdAt: now, updatedAt: now,
    }, {
      id: 'element-equation-test', paperId: imported.paper.id, workspacePath: workspace, elementType: 'equation', section: 'Method',
      pdfPageStart: 5, pdfPageEnd: 5, lineStart: 30, lineEnd: 31, readingOrder: 2,
      content: 'E = mc^2', caption: null, contentFormat: 'latex', createdAt: now, updatedAt: now,
    }])
    const hits = store.searchPaperElements({ workspacePath: workspace, query: 'accuracy', types: ['table'], limit: 6 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.elementType, 'table')
    assert.equal(hits[0]?.pdfPageStart, 4)
    const read = store.readPaperElement({ workspacePath: workspace, elementId: 'element-equation-test', maxChars: 256 })
    assert.equal(read.citation.elementType, 'equation')
    assert.equal(read.citation.pdfPageStart, 5)
    assert.match(read.content, /mc\^2/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('requeues a completed embedding job for an explicit paper reindex', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source })
    store.commitPaperParseRevision(workspace, imported.paper.id, 'revision-test', [], [], [], 'mineru-test')
    const options = { provider: 'dashscope', model: 'qwen3-vl-embedding', dimensions: 1024 }
    const initial = store.createEmbeddingJob(workspace, imported.paper.id, options)
    store.updateEmbeddingJob(workspace, initial.id, { status: 'ready', completedItems: initial.totalItems, finishedAt: new Date().toISOString() })
    const restarted = store.restartEmbeddingJob(workspace, imported.paper.id, options)
    assert.equal(restarted.id, initial.id)
    assert.equal(restarted.status, 'queued')
    assert.equal(restarted.completedItems, 0)
    assert.equal(restarted.error, null)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('requires reparsing before indexing a paper without an immutable revision', async () => {
  const { root, store } = await fixture()
  try {
    const workspace = join(root, 'workspace')
    const source = join(root, 'article.pdf')
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nlegacy example')
    const imported = await store.importPaper({ workspacePath: workspace, sourcePath: source })
    store.setParseStatus(workspace, imported.paper.id, 'ready', { parserVersion: 'legacy-mineru' })
    assert.throws(
      () => store.restartEmbeddingJob(workspace, imported.paper.id, { provider: 'dashscope', model: 'qwen3-vl-embedding', dimensions: 1024 }),
      /immutable parse revision/,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
