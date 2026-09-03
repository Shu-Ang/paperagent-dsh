/** MinerU precision API parser with local durable artifacts and provenance. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { paperArtifactPaths, PaperAgentStore } from '@paperagent/domain'
import type { PaperChunkRecord, PaperElementRecord, PaperElementType, PaperRecord, PaperReferenceRecord, PaperSectionRecord } from '@paperagent/domain'
import { readZipArchive, requireArchiveText } from './archive.ts'
import { parseContentList, type ContentBlock } from './content-list.ts'
import { replaceFigureAssets, type FigureAssetReplacement } from './figure-assets.ts'
import { delay, ensureTrailingNewline, networkErrorMessage, normalizeBaseUrl, normalizeText, numberValue, readJsonResponse, record, stringValue, throwIfAborted, userSafeError, withSignal, writeArtifactPair } from './parser-utils.ts'

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const CHUNK_CHARACTER_LIMIT = 1_400
const MIN_TRAILING_CHUNK_CHARACTERS = 200
const MAX_TRAILING_MERGED_CHUNK_CHARACTERS = CHUNK_CHARACTER_LIMIT + 240
const AUXILIARY_BLOCK_TYPES = new Set([
  'header', 'footer', 'page_number', 'aside_text', 'page_footnote',
  'page_header', 'page_footer', 'page_aside_text',
])
const STRUCTURED_ELEMENT_TYPES = new Set<PaperElementType>(['figure', 'table', 'equation', 'code', 'list'])

export type MineruModelVersion = 'pipeline' | 'vlm'

export interface MineruPrecisionConfig {
  readonly apiBaseUrl: string
  /** Optional direct token for standalone use; the DSH plugin resolves a credential reference per parse instead. */
  readonly apiToken?: string
  readonly modelVersion: MineruModelVersion
  readonly enableOcr: boolean
  readonly enableFormula: boolean
  readonly enableTable: boolean
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export interface SourceMapDocument {
  readonly version: 5
  readonly parserVersion: string
  readonly paperId: string
  readonly generatedAt: string
  readonly sections: readonly SourceMapSection[]
  readonly chunks: readonly SourceMapChunk[]
  readonly elements: readonly SourceMapElement[]
  readonly references: readonly SourceMapReference[]
}

export interface SourceMapChunk {
  readonly id: string
  readonly section: string
  readonly sectionId: string
  readonly parentSectionId: string | null
  readonly chunkType: 'child'
  readonly sequence: number
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly blockType: string
  readonly readingOrder: number
  readonly elementIds: readonly string[]
}

export interface SourceMapElement {
  readonly id: string
  readonly elementType: PaperElementType
  readonly section: string
  readonly sectionId: string
  readonly parentSectionId: string | null
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly readingOrder: number
}

export interface SourceMapReference {
  readonly id: string
  readonly paperId: string
  readonly ordinal: number
  readonly label: string | null
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
}

export interface SourceMapSection {
  readonly id: string
  readonly title: string
  readonly level: number
  readonly parentId: string | null
  readonly path: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly readingOrder: number
}

export interface ParsedPaperArtifact {
  readonly paper: PaperRecord
  readonly markdownPath: string
  readonly sourceMapPath: string
  readonly chunkCount: number
  readonly elementCount: number
  readonly referenceCount: number
}

export interface ParsePaperOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: { readonly currentPage: number; readonly totalPages: number }) => void
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface MineruPrecisionParserOptions {
  readonly config: MineruPrecisionConfig
  readonly fetch?: FetchLike
  /** Resolves the host-only MinerU token at the beginning of each parse operation. */
  readonly resolveApiToken?: () => Promise<string>
}

interface MineruBatchResult {
  readonly batchId: string
  readonly fileUrl: string
}

interface MineruPollResult {
  readonly state: string
  readonly archiveUrl?: string
  readonly error?: string
  readonly currentPage?: number
  readonly totalPages?: number
  readonly traceId?: string
}

/**
 * The only PDF parser used by PaperAgent. It sends a locally stored PDF to the
 * configured MinerU precision endpoint, then keeps the final Markdown and
 * provenance locally. There is intentionally no PDF.js/Poppler fallback.
 */
export class MineruPrecisionParser {
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly parserVersion: string

  constructor(private readonly options: MineruPrecisionParserOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.baseUrl = normalizeBaseUrl(options.config.apiBaseUrl)
    this.parserVersion = `mineru-precision-api/v5:${options.config.modelVersion}`
  }

  async parse(
    store: PaperAgentStore,
    workspacePath: string,
    paperId: string,
    parseOptions: ParsePaperOptions = {},
  ): Promise<ParsedPaperArtifact> {
    const paper = store.getPaper(workspacePath, paperId)
    const activePaths = paperArtifactPaths(paper)
    const revision = randomUUID()
    const stagingPaths = paperArtifactPaths(paper, `${revision}-staging`)
    const revisionPaths = paperArtifactPaths(paper, revision)
    let figureAssets: FigureAssetReplacement | undefined
    let revisionInstalled = false
    store.setParseStatus(workspacePath, paperId, 'parsing', { parserVersion: this.parserVersion })
    try {
      throwIfAborted(parseOptions.signal)
      const apiToken = await this.resolveApiToken()
      const upload = await this.createUploadTask(paper, apiToken, parseOptions.signal)
      await this.uploadPdf(upload.fileUrl, activePaths.pdf, parseOptions.signal)
      const completed = await this.waitForResult(upload.batchId, apiToken, parseOptions)
      if (completed.archiveUrl === undefined) throw new Error('MinerU completed without a result archive URL')
      const archive = await this.downloadArchive(completed.archiveUrl, parseOptions.signal)
      const files = readZipArchive(archive)
      const markdown = requireArchiveText(files, /(?:^|\/)full\.md$/i, 'full.md')
      const contentList = parseContentList(files)
      const generated = buildCiteableArtifacts(paper, markdown, contentList, this.parserVersion)
      await mkdir(stagingPaths.directory, { recursive: true })
      figureAssets = await replaceFigureAssets(stagingPaths.images, paper, markdown, contentList, files)
      await writeArtifactPair(
        stagingPaths.markdown,
        ensureTrailingNewline(markdown),
        stagingPaths.sourceMap,
        `${JSON.stringify(generated.sourceMap, null, 2)}\n`,
      )
      // The complete immutable directory becomes reachable only after its
      // content is fully written. SQLite then atomically points the paper and
      // every derived index at this revision in one transaction.
      await rename(stagingPaths.directory, revisionPaths.directory)
      revisionInstalled = true
      const readyPaper = store.commitPaperParseRevision(
        workspacePath, paperId, revision, generated.chunks, generated.elements, figureAssets.figures, this.parserVersion, generated.sections, generated.references,
      )
      await figureAssets.finalize()
      // Parsed artifacts belong exclusively to the immutable revision. Remove
      // any files left by the pre-revision layout after the new revision is
      // durable, while preserving original.pdf at the paper root.
      await removeRootParsedArtifacts(paperArtifactPaths(paper, null)).catch(() => undefined)
      return { paper: readyPaper, markdownPath: revisionPaths.markdown, sourceMapPath: revisionPaths.sourceMap, chunkCount: generated.chunks.length, elementCount: generated.elements.length, referenceCount: generated.references.length }
    } catch (error) {
      let reportedError = error
      try {
        await Promise.all([
          rm(stagingPaths.directory, { recursive: true, force: true }),
          ...(revisionInstalled ? [rm(revisionPaths.directory, { recursive: true, force: true })] : []),
        ])
      } catch (restoreError) {
        reportedError = new Error(`${userSafeError(error)}; failed to restore the previous local artifacts: ${userSafeError(restoreError)}`)
      }
      const message = userSafeError(reportedError)
      store.setParseStatus(workspacePath, paperId, 'failed', { error: message, parserVersion: this.parserVersion })
      throw reportedError
    }
  }

  private async createUploadTask(paper: PaperRecord, apiToken: string, signal: AbortSignal | undefined): Promise<MineruBatchResult> {
    const response = await this.request('/api/v4/file-urls/batch', withSignal({
      method: 'POST',
      headers: this.headers(apiToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        files: [{ name: paper.originalFileName, data_id: paper.id, is_ocr: this.options.config.enableOcr }],
        model_version: this.options.config.modelVersion,
        enable_formula: this.options.config.enableFormula,
        enable_table: this.options.config.enableTable,
      }),
    }, signal), 'create MinerU upload task')
    const body = await readJsonResponse(response, 'create MinerU upload task')
    const data = record(body.data)
    const batchId = stringValue(data.batch_id)
    const urls = data.file_urls
    if (batchId === undefined || !Array.isArray(urls) || typeof urls[0] !== 'string') {
      throw new Error('MinerU create-upload response is missing batch_id or file_urls[0]')
    }
    return { batchId, fileUrl: urls[0] }
  }

  private async uploadPdf(fileUrl: string, pdfPath: string, signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal)
    const data = await readFile(pdfPath)
    const response = await this.fetchExternal(fileUrl, withSignal({ method: 'PUT', body: data }, signal), 'upload PDF to MinerU')
    if (!response.ok) throw new Error(`MinerU signed PDF upload failed with HTTP ${response.status}`)
  }

  private async waitForResult(batchId: string, apiToken: string, options: ParsePaperOptions): Promise<MineruPollResult> {
    const startedAt = Date.now()
    while (true) {
      throwIfAborted(options.signal)
      const response = await this.request(`/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, withSignal({ headers: this.headers(apiToken) }, options.signal), 'query MinerU parse task')
      const parsed = await readJsonResponse(response, 'query MinerU parse task')
      const result = parsePollResult(parsed)
      if (result.currentPage !== undefined && result.totalPages !== undefined) {
        options.onProgress?.({ currentPage: result.currentPage, totalPages: result.totalPages })
      }
      if (result.state === 'done') return result
      if (result.state === 'failed') throw new Error(result.error === undefined ? 'MinerU parsing failed' : `MinerU parsing failed: ${result.error}`)
      if (Date.now() - startedAt >= this.options.config.timeoutMs) throw new Error('MinerU parsing timed out')
      await delay(this.options.config.pollIntervalMs, options.signal)
    }
  }

  private async downloadArchive(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const response = await this.fetchExternal(url, withSignal({}, signal), 'download MinerU result archive')
    if (!response.ok) throw new Error(`MinerU result download failed with HTTP ${response.status}`)
    const size = Number(response.headers.get('content-length'))
    if (Number.isFinite(size) && size > MAX_ARCHIVE_BYTES) throw new Error('MinerU result archive exceeds the local safety limit')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('MinerU result archive exceeds the local safety limit')
    return bytes
  }

  private request(path: string, init: RequestInit, operation: string): Promise<Response> {
    return this.fetchExternal(`${this.baseUrl}${path}`, init, operation)
  }

  /** Never include a signed URL in diagnostics: its query can be a credential. */
  private async fetchExternal(url: string, init: RequestInit, operation: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, init)
    } catch (error) {
      if (init.signal?.aborted === true) throw new Error('parsing cancelled')
      throw new Error(`${operation} network request failed: ${networkErrorMessage(error)}`)
    }
  }

  private headers(apiToken: string, headers: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${apiToken}`, ...headers }
  }

  private async resolveApiToken(): Promise<string> {
    const token = await (this.options.resolveApiToken?.() ?? Promise.resolve(this.options.config.apiToken))
    if (token === undefined || token.trim() === '') throw new Error('MinerU API token is not configured')
    const normalized = token.trim()
    if (/^bearer\s+/i.test(normalized)) throw new Error('MinerU API token must not include the Bearer prefix; save only the token value')
    if (/^[A-Z_][A-Z0-9_]*\s*=/.test(normalized)) throw new Error('MinerU API token must be the token value, not an environment-variable assignment')
    if (/\s/.test(normalized)) throw new Error('MinerU API token contains whitespace; save only the token value')
    return normalized
  }
}

async function removeRootParsedArtifacts(paths: ReturnType<typeof paperArtifactPaths>): Promise<void> {
  await Promise.all([
    rm(paths.markdown, { force: true }),
    rm(paths.sourceMap, { force: true }),
    rm(paths.images, { recursive: true, force: true }),
  ])
}

export function createMineruPrecisionParser(config: MineruPrecisionConfig): MineruPrecisionParser {
  return new MineruPrecisionParser({ config })
}

function parsePollResult(payload: unknown): MineruPollResult {
  const root = record(payload)
  const data = record(root.data)
  const results = Array.isArray(data.extract_result) ? data.extract_result : Array.isArray(data.extract_results) ? data.extract_results : []
  const first = results[0]
  const result = first === undefined ? data : record(first)
  const progress = record(result.extract_progress)
  return {
    state: stringValue(result.state) ?? 'failed',
    ...(stringValue(result.full_zip_url) === undefined ? {} : { archiveUrl: stringValue(result.full_zip_url)! }),
    ...(stringValue(result.err_msg) === undefined ? {} : { error: stringValue(result.err_msg)! }),
    ...(numberValue(progress.extracted_pages) === undefined ? {} : { currentPage: numberValue(progress.extracted_pages)! }),
    ...(numberValue(progress.total_pages) === undefined ? {} : { totalPages: numberValue(progress.total_pages)! }),
    ...(stringValue(root.trace_id) === undefined ? {} : { traceId: stringValue(root.trace_id)! }),
  }
}

function buildCiteableArtifacts(
  paper: PaperRecord,
  markdown: string,
  blocks: readonly ContentBlock[],
  parserVersion: string,
): { readonly chunks: readonly PaperChunkRecord[]; readonly elements: readonly PaperElementRecord[]; readonly sections: readonly PaperSectionRecord[]; readonly references: readonly PaperReferenceRecord[]; readonly sourceMap: SourceMapDocument } {
  const index = new MarkdownIndex(markdown)
  let chunks: PaperChunkRecord[] = []
  const elements: PaperElementRecord[] = []
  const references: PaperReferenceRecord[] = []
  interface SectionState {
    id: string; paperId: string; workspacePath: string; title: string; level: number; parentId: string | null; path: string
    pdfPageStart: number; pdfPageEnd: number; lineStart: number; lineEnd: number; readingOrder: number; createdAt: string
    children: SectionState[]
  }
  const root: SectionState = {
    id: randomUUID(), paperId: paper.id, workspacePath: paper.workspacePath, title: 'Document', level: 0, parentId: null, path: 'Document',
    pdfPageStart: 1, pdfPageEnd: Math.max(1, blocks.at(-1)?.page ?? 1), lineStart: 1, lineEnd: Math.max(1, markdown.split(/\r?\n/u).length), readingOrder: 0,
    createdAt: new Date().toISOString(), children: [],
  }
  const sectionById = new Map<string, SectionState>([[root.id, root]])
  const sectionStates: SectionState[] = [root]
  let sourceChunks: SourceMapChunk[] = []
  const sourceElements: SourceMapElement[] = []
  const sourceReferences: SourceMapReference[] = []
  const sourceSections: SourceMapSection[] = []
  const sectionStack: SectionState[] = [root]
  const sequenceBySection = new Map<string, number>()
  const paragraphStack: Array<{ readonly block: ContentBlock; readonly text: string; readonly section: SectionState }> = []
  const usedReferenceOrdinals = new Set<number>()
  let nextReferenceOrdinal = 1
  // The first MinerU title block is the synthetic paper-title section. Some
  // archives do not contain that block and start directly at `1 Introduction`,
  // so we only treat a first heading as the title when it does not look like a
  // conventional paper section heading.
  let documentTitleDetected = false
  // Text between the synthetic paper-title section and the first real heading
  // is front matter. Standalone author/affiliation blocks are ignored there;
  // the first non-author block ends this phase so Abstract content keeps the
  // existing parsing behavior unchanged.
  let frontMatter = true
  let referencesSectionDetected = false

  const currentSection = (): SectionState => sectionStack.at(-1) ?? root
  const touchSection = (section: SectionState, page: number, lineStart: number, lineEnd: number): void => {
    let current: SectionState | undefined = section
    while (current !== undefined) {
      current.pdfPageStart = Math.min(current.pdfPageStart, page)
      current.pdfPageEnd = Math.max(current.pdfPageEnd, page)
      current.lineStart = Math.min(current.lineStart, lineStart)
      current.lineEnd = Math.max(current.lineEnd, lineEnd)
      current = current.parentId === null ? undefined : sectionById.get(current.parentId)
    }
  }

  /** Opens a section from a MinerU heading or a synthetic References boundary. */
  const openSection = (title: string, rawDepth: number, page: number, headingLocation: { readonly lineStart: number; readonly lineEnd: number }): void => {
    const isDocumentTitle = !documentTitleDetected && sectionStates.length === 1 && !looksLikeSectionHeading(title)
    const fallbackDepth = documentTitleDetected ? Math.max(1, rawDepth - 1) : rawDepth
    const semanticDepth = isDocumentTitle ? undefined : inferSectionDepth(title, fallbackDepth)
    const level = isDocumentTitle ? 1 : Math.max(1, (semanticDepth ?? fallbackDepth) + (documentTitleDetected ? 1 : 0))
    if (isDocumentTitle) documentTitleDetected = true
    else frontMatter = false
    while (sectionStack.length > 1 && (sectionStack.at(-1)?.level ?? 0) >= level) sectionStack.pop()
    const parent = currentSection()
    const sectionState: SectionState = {
      id: randomUUID(), paperId: paper.id, workspacePath: paper.workspacePath, title, level, parentId: parent.id,
      path: `${parent.path} > ${title}`, pdfPageStart: page, pdfPageEnd: page, lineStart: Math.max(1, headingLocation.lineStart), lineEnd: Math.max(1, headingLocation.lineEnd),
      readingOrder: sectionStates.length, createdAt: new Date().toISOString(), children: [],
    }
    parent.children.push(sectionState)
    sectionStates.push(sectionState)
    sectionById.set(sectionState.id, sectionState)
    sectionStack.push(sectionState)
    if (isReferencesHeading(title)) referencesSectionDetected = true
  }

  const addElement = (block: ContentBlock & { readonly elementType: PaperElementType }, sectionState: SectionState): string => {
    const id = randomUUID()
    const location = block.text.trim() === '' ? { lineStart: null, lineEnd: null } : index.locate(block.text.trim())
    const element: PaperElementRecord = {
      id, paperId: paper.id, workspacePath: paper.workspacePath, elementType: block.elementType,
      section: sectionState.path, pdfPageStart: block.page, pdfPageEnd: block.page,
      lineStart: location.lineStart, lineEnd: location.lineEnd, readingOrder: block.readingOrder,
      content: block.text.trim() === '' ? block.imagePath ?? block.caption ?? '[figure]' : block.text.trim(),
      caption: block.caption ?? null, contentFormat: block.contentFormat, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    elements.push(element)
    sourceElements.push({
      id, elementType: element.elementType, section: sectionState.path, sectionId: sectionState.id, parentSectionId: sectionState.parentId, pdfPageStart: element.pdfPageStart, pdfPageEnd: element.pdfPageEnd,
      lineStart: element.lineStart, lineEnd: element.lineEnd, readingOrder: element.readingOrder,
    })
    return id
  }

  const addReferences = (block: ContentBlock, sectionState: SectionState): void => {
    for (const entryText of splitReferenceEntries(block.text)) {
      const parsed = parseReferenceText(entryText)
      let ordinal = parsed.ordinal ?? nextReferenceOrdinal
      while (usedReferenceOrdinals.has(ordinal)) ordinal += 1
      usedReferenceOrdinals.add(ordinal)
      nextReferenceOrdinal = Math.max(nextReferenceOrdinal, ordinal + 1)
      const location = index.locate(entryText)
      const now = new Date().toISOString()
      const reference: PaperReferenceRecord = {
        id: randomUUID(), paperId: paper.id, workspacePath: paper.workspacePath, ordinal, label: parsed.label,
        rawText: entryText, authors: parsed.authors, title: parsed.title, year: parsed.year, venue: parsed.venue,
        doi: parsed.doi, url: parsed.url, section: sectionState.path, pdfPageStart: block.page, pdfPageEnd: block.page,
        lineStart: location.lineStart, lineEnd: location.lineEnd, createdAt: now, updatedAt: now,
      }
      references.push(reference)
      sourceReferences.push({ id: reference.id, paperId: paper.id, ordinal: reference.ordinal, label: reference.label, section: reference.section, pdfPageStart: reference.pdfPageStart, pdfPageEnd: reference.pdfPageEnd, lineStart: reference.lineStart, lineEnd: reference.lineEnd })
    }
  }

  const flush = (): void => {
    const content = paragraphStack.map(item => item.text).join('\n\n').trim()
    const first = paragraphStack[0]
    const last = paragraphStack.at(-1)
    if (content === '' || first === undefined || last === undefined) {
      paragraphStack.length = 0
      return
    }
    const id = randomUUID()
    const location = index.locate(content)
    const sectionState = first.section
    const sequence = (sequenceBySection.get(sectionState.id) ?? 0) + 1
    sequenceBySection.set(sectionState.id, sequence)
    const chunk: PaperChunkRecord = {
      id, paperId: paper.id, workspacePath: paper.workspacePath, section: sectionState.path, sectionId: sectionState.id, parentSectionId: sectionState.parentId, chunkType: 'child', sequence,
      pdfPageStart: first.block.page, pdfPageEnd: last.block.page,
      lineStart: location.lineStart, lineEnd: location.lineEnd, elementIds: [],
      content, createdAt: new Date().toISOString(),
    }
    chunks.push(chunk)
    touchSection(sectionState, first.block.page, location.lineStart, location.lineEnd)
    sourceChunks.push({
      id, section: sectionState.path, sectionId: sectionState.id, parentSectionId: sectionState.parentId, chunkType: 'child', sequence, pdfPageStart: first.block.page, pdfPageEnd: last.block.page,
      lineStart: location.lineStart, lineEnd: location.lineEnd,
      blockType: first.block.type, readingOrder: first.block.readingOrder, elementIds: [],
    })
    paragraphStack.length = 0
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!
    if (AUXILIARY_BLOCK_TYPES.has(block.type)) continue
    const standaloneReferencesHeading = block.headingLevel === undefined && isReferencesHeading(block.text)
    if ((block.headingLevel !== undefined && block.headingLevel > 0) || standaloneReferencesHeading) {
      flush()
      const title = block.text.trim()
      if (title === '') continue
      const headingLocation = index.locate(title)
      openSection(title, standaloneReferencesHeading ? 1 : Math.max(1, Math.trunc(block.headingLevel ?? 1)), block.page, headingLocation)
      continue
    }
    // MinerU occasionally omits the References heading while still returning
    // each bibliography entry as a list block. Detect a sustained run of
    // citation-shaped list entries and create a stable synthetic boundary so
    // they are not attached to the preceding conclusion/appendix section.
    if (!referencesSectionDetected && isReferenceEntryCandidate(block) && referenceEntryRunLength(blocks, blockIndex) >= 2) {
      flush()
      const location = index.locate(block.text.trim())
      openSection('References', 1, block.page, location)
    }
    if (block.text.trim() === '' && block.elementType !== 'figure') continue
    const sectionState = currentSection()
    const inReferencesSection = sectionStack.some(section => isReferencesHeading(section.title))
    if (inReferencesSection && (block.elementType === 'list' || isReferenceTextBlock(block))) {
      flush()
      addReferences(block, sectionState)
      if (isStructuredElement(block)) block.elementId = addElement(block, sectionState)
      continue
    }
    if (isStructuredElement(block)) {
      flush()
      block.elementId = addElement(block, sectionState)
      continue
    }
    if (documentTitleDetected && frontMatter && block.elementType === 'text') {
      if (isLikelyAuthorBlock(block.text)) continue
      frontMatter = false
    }
    const units = splitTextBlock(block.text)
    for (const unit of units) {
      if (unit === '') continue
      const currentLength = paragraphStack.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, paragraphStack.length - 1) * 2
      // Keep natural paragraphs intact. Short paragraphs are merged by the
      // pending stack until the preferred target, but never across sections.
      if (paragraphStack.length > 0 && (paragraphStack.at(-1)?.section.id !== sectionState.id || currentLength + unit.length + 2 > CHUNK_CHARACTER_LIMIT || (currentLength >= 900 && unit.length > 300))) flush()
      paragraphStack.push({ block, text: unit, section: sectionState })
    }
  }
  flush()

  // Greedy packing can leave a tiny tail when the final paragraph would have
  // crossed the target limit. Merge such a tail back into the previous chunk
  // of the same section, allowing a small soft overflow so retrieval does not
  // expose fragments such as a final 20-character sentence.
  ;({ chunks, sourceChunks } = coalesceTrailingChunks(chunks, sourceChunks))

  // Link each structured element to the nearest textual child chunk. The
  // relation is based on logical section and Markdown/PDF proximity, never on
  // bounding boxes, so embedding and agent context expansion remain stable
  // across MinerU layout variations.
  const elementIdsByChunk = new Map<string, string[]>()
  for (const element of elements) {
    const sameSection = chunks.filter(chunk => chunk.sectionId === element.sectionId)
    const candidates = sameSection.length > 0 ? sameSection : chunks
    const nearest = candidates
      .map(chunk => ({ chunk, distance: locationDistance(chunk, element) }))
      .sort((left, right) => left.distance - right.distance || left.chunk.lineStart - right.chunk.lineStart)[0]?.chunk
    if (nearest !== undefined) elementIdsByChunk.set(nearest.id, [...(elementIdsByChunk.get(nearest.id) ?? []), element.id])
  }
  const linkedChunks = chunks.map(chunk => ({ ...chunk, elementIds: elementIdsByChunk.get(chunk.id) ?? [] }))
  const linkedSourceChunks = sourceChunks.map(chunk => ({ ...chunk, elementIds: elementIdsByChunk.get(chunk.id) ?? [] }))

  const sections = sectionStates.map(({ children: _children, ...section }) => section)
  for (const section of sections) sourceSections.push(toSourceSection(section))

  return {
    chunks: linkedChunks,
    elements, sections, references, sourceMap: { version: 5, parserVersion, paperId: paper.id, generatedAt: new Date().toISOString(), sections: sourceSections, chunks: linkedSourceChunks, elements: sourceElements, references: sourceReferences },
  }
}

function coalesceTrailingChunks(
  chunks: readonly PaperChunkRecord[],
  sourceChunks: readonly SourceMapChunk[],
): { readonly chunks: PaperChunkRecord[]; readonly sourceChunks: SourceMapChunk[] } {
  const nextChunks = [...chunks]
  const nextSourceChunks = [...sourceChunks]
  const indexesBySection = new Map<string, number[]>()
  for (let index = 0; index < nextChunks.length; index += 1) {
    const chunk = nextChunks[index]
    if (chunk === undefined) continue
    const indexes = indexesBySection.get(chunk.sectionId ?? '') ?? []
    indexes.push(index)
    indexesBySection.set(chunk.sectionId ?? '', indexes)
  }

  const removed = new Set<number>()
  for (const indexes of indexesBySection.values()) {
    while (indexes.length > 1) {
      const tailIndex = indexes.at(-1)!
      const previousIndex = indexes.at(-2)!
      const tail = nextChunks[tailIndex]
      const previous = nextChunks[previousIndex]
      const tailSource = nextSourceChunks[tailIndex]
      const previousSource = nextSourceChunks[previousIndex]
      if (tail === undefined || previous === undefined || tailSource === undefined || previousSource === undefined) break
      if (tail.content.trim().length >= MIN_TRAILING_CHUNK_CHARACTERS) break
      const mergedContent = `${previous.content.trimEnd()}\n\n${tail.content.trimStart()}`
      if (mergedContent.length > MAX_TRAILING_MERGED_CHUNK_CHARACTERS) break

      nextChunks[previousIndex] = {
        ...previous,
        content: mergedContent,
        pdfPageEnd: Math.max(previous.pdfPageEnd, tail.pdfPageEnd),
        lineEnd: Math.max(previous.lineEnd, tail.lineEnd),
      }
      nextSourceChunks[previousIndex] = {
        ...previousSource,
        pdfPageEnd: Math.max(previousSource.pdfPageEnd, tailSource.pdfPageEnd),
        lineEnd: Math.max(previousSource.lineEnd, tailSource.lineEnd),
      }
      removed.add(tailIndex)
      indexes.pop()
    }
  }

  return {
    chunks: nextChunks.filter((_chunk, index) => !removed.has(index)),
    sourceChunks: nextSourceChunks.filter((_chunk, index) => !removed.has(index)),
  }
}

function locationDistance(chunk: PaperChunkRecord, element: PaperElementRecord): number {
  if (element.lineStart !== null && element.lineStart >= chunk.lineStart && element.lineStart <= chunk.lineEnd) return 0
  const lineDistance = element.lineStart === null ? Number.POSITIVE_INFINITY : Math.min(Math.abs(element.lineStart - chunk.lineEnd), Math.abs(chunk.lineStart - element.lineStart))
  const pageDistance = chunk.pdfPageStart <= element.pdfPageEnd && chunk.pdfPageEnd >= element.pdfPageStart
    ? 0 : Math.min(Math.abs(chunk.pdfPageStart - element.pdfPageEnd), Math.abs(element.pdfPageStart - chunk.pdfPageEnd))
  return Math.min(lineDistance, pageDistance * 100)
}

function toSourceSection(section: PaperSectionRecord): SourceMapSection {
  return { id: section.id, title: section.title, level: section.level, parentId: section.parentId, path: section.path, pdfPageStart: section.pdfPageStart, pdfPageEnd: section.pdfPageEnd, lineStart: section.lineStart, lineEnd: section.lineEnd, readingOrder: section.readingOrder }
}

function isStructuredElement(block: ContentBlock): block is ContentBlock & { readonly elementType: PaperElementType } {
  return STRUCTURED_ELEMENT_TYPES.has(block.elementType as PaperElementType)
}

/**
 * Recognizes short title-page author metadata without classifying prose as
 * metadata. This is intentionally conservative: a block containing an
 * Abstract marker or ordinary sentence verbs remains searchable text.
 */
function isLikelyAuthorBlock(value: string): boolean {
  const normalized = value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized === '' || normalized.length > 600) return false
  if (/^abstract\s*(?:[:：\-—–]|$)/iu.test(normalized)) return false
  if (/\b(?:we|our|this|that|propose|present|introduce|develop|show|demonstrate|aim|method|approach|results?)\b/iu.test(normalized)) return false

  const authorMarker = /(?:@|\b(?:university|institute|department|school|college|laborator(?:y|ies)|academy|research center|corresponding author|senior member|IEEE)\b)/iu.test(normalized)
  if (authorMarker) return true

  const words = normalized
    .replace(/[,:;，；、()[\]{}]/gu, ' ')
    .split(/\s+/u)
    .map(word => word.replace(/^[^\p{L}]+|[^\p{L}.'’\-]+$/gu, ''))
    .filter(Boolean)
  if (words.length < 2 || words.length > 16) return false
  const nameLike = words.filter(word => /^[A-ZÀ-ÖØ-Þ][\p{L}.'’\-]*$/u.test(word)).length
  return nameLike >= 2 && nameLike / words.length >= 0.6
}

/**
 * MinerU's heading level is often the Markdown rendering level (`2`) for all
 * paper headings. Prefer the semantic numbering used by the paper itself so
 * `3.3.1` becomes a child of `3.3`, while keeping the old level as fallback
 * for headings that carry no recognizable numbering.
 */
function inferSectionDepth(title: string, fallback: number): number {
  const normalized = title.trim()
  const numbered = normalized.match(/^(\d+(?:\.\d+)*)(?:\.?\s+|\s*$)/u)?.[1]
  if (numbered !== undefined) return numbered.split('.').length
  // IEEE-style appendix/subsection labels such as `C. Vehicle Detection`
  // collide with the Roman-numeral alphabet. Title-case text after a single
  // letter is treated as a letter subsection; all-caps text remains a Roman
  // top-level heading (`I. INTRODUCTION`).
  if (/^[A-Z]\s*\.\s+[A-Z][a-z]/u.test(normalized)) return 2
  if (/^[IVXLCDM]+\s*\.\s*/iu.test(normalized)) return 1
  if (/^[A-Z]\s*\.\s*/u.test(normalized)) return 2
  if (/^(?:abstract|references|acknowledg(?:e)?ments?)$/iu.test(normalized)) return 1
  if (/^[一二三四五六七八九十百]+\s*[、.]\s*/u.test(normalized)) return 1
  if (/^（[一二三四五六七八九十百]+）/u.test(normalized)) return 2
  return Math.max(1, Math.trunc(fallback))
}

function looksLikeSectionHeading(title: string): boolean {
  const normalized = title.trim()
  return inferSectionDepth(normalized, 0) > 0 && (
    /^\d+(?:\.\d+)*(?:\.?\s+|\s*$)/u.test(normalized)
    || /^[IVXLCDM]+\s*\.\s*/iu.test(normalized)
    || /^[A-Z]\s*\.\s*/u.test(normalized)
    || /^(?:abstract|references|acknowledg(?:e)?ments?)$/iu.test(normalized)
    || /^[一二三四五六七八九十百]+\s*[、.]\s*/u.test(normalized)
    || /^（[一二三四五六七八九十百]+）/u.test(normalized)
  )
}

function isReferencesHeading(title: string): boolean {
  return /^(?:references|bibliography|参考文献|引用文献)$/iu.test(title.trim().replace(/[:：]$/u, ''))
}

/**
 * Recognizes the common bibliography-entry shapes emitted by MinerU. The
 * check intentionally requires a list element and a citation marker/year (or
 * DOI) so ordinary bullet lists in a conclusion are not reparented.
 */
function isReferenceEntryBlock(block: ContentBlock): boolean {
  if (block.elementType !== 'list') return false
  const text = block.text.trim()
  if (text === '') return false
  const marker = /^\s*(?:\[\s*(?:\d{1,3}|[A-Za-z][^\]]{1,100})\s*\]|\d{1,3}[.)])\s*/u.test(text)
  const year = /\b(?:18|19|20|21)\d{2}[a-z]?\b/u.test(text)
  const doi = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/iu.test(text)
  return doi || (marker && year)
}

/**
 * MinerU may emit bibliography rows as ordinary text instead of list items.
 * Keep the synthetic References detector aligned with the later parser branch
 * so those rows are not silently folded into the preceding section's chunks.
 */
function isReferenceEntryCandidate(block: ContentBlock): boolean {
  return isReferenceEntryBlock(block) || isReferenceTextBlock(block)
}

function isReferenceTextBlock(block: ContentBlock): boolean {
  if (block.elementType !== 'text') return false
  const text = block.text.trim()
  return /^\s*(?:\[\s*(?:\d{1,3}|[A-Za-z][^\]]{1,100})\s*\]|\d{1,3}[.)])\s+/u.test(text)
    && /\b(?:18|19|20|21)\d{2}[a-z]?\b/u.test(text)
}

function referenceEntryRunLength(blocks: readonly ContentBlock[], start: number): number {
  let length = 0
  for (let index = start; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined || AUXILIARY_BLOCK_TYPES.has(block.type)) continue
    if (!isReferenceEntryCandidate(block)) break
    length += 1
  }
  return length
}

function splitReferenceEntries(value: string): readonly string[] {
  const normalized = value.replaceAll('\r\n', '\n').trim()
  if (normalized === '') return []
  const entries = normalized.split(/(?=(?:\[\s*(?:\d{1,3}|[A-Za-z][^\]]{1,100})\s*\]|\d{1,3}[.)])\s+)/u).map(item => item.trim()).filter(Boolean)
  return entries.length === 0 ? [normalized] : entries
}

function parseReferenceText(value: string): {
  readonly ordinal?: number
  readonly label: string | null
  readonly authors: readonly string[]
  readonly title: string | null
  readonly year: number | null
  readonly venue: string | null
  readonly doi: string | null
  readonly url: string | null
} {
  const text = value.trim()
  const labelMatch = text.match(/^\s*(?:\[\s*([^\]]+)\s*\]|(\d{1,3})[.)])\s*/u)
  const label = labelMatch?.[1] ?? labelMatch?.[2] ?? null
  const numericLabel = label === null ? undefined : /^\d+$/u.test(label) ? Number(label) : undefined
  const body = labelMatch === null ? text : text.slice(labelMatch[0].length).trim()
  const doi = body.match(/\b(10\.\d{4,9}\/[\-._;()/:A-Z0-9]+)\b/iu)?.[1] ?? null
  const url = body.match(/https?:\/\/[^\s>]+/iu)?.[0]?.replace(/[),.;]+$/u, '') ?? (doi === null ? null : `https://doi.org/${doi}`)
  const years = [...body.matchAll(/\b((?:18|19|20|21)\d{2})[a-z]?\b/gu)].map(match => Number(match[1])).filter(Number.isFinite)
  const year = years.at(-1) ?? null
  const quoted = body.match(/[“"]([^”"]{3,300})[”"]/u) ?? body.match(/[‘']([^’']{3,300})[’']/u)
  const title = quoted?.[1]?.trim().replace(/[,.;:]+$/u, '') ?? null
  const authorPrefix = title === null ? '' : body.slice(0, body.indexOf(quoted?.[0] ?? '')).replace(/[,:;.]\s*$/u, '').trim()
  const authors = authorPrefix === '' ? [] : authorPrefix.split(/\s*;\s*|\s+and\s+/iu).map(item => item.trim()).filter(Boolean).slice(0, 20)
  return { ...(numericLabel === undefined ? {} : { ordinal: numericLabel }), label, authors, title, year, venue: null, doi, url }
}

/**
 * Splits only ordinary text blocks. Blank-line paragraphs stay intact; an
 * unusually long paragraph is packed by sentence, and only an unbreakable
 * sentence falls back to a whitespace/character boundary.
 */
function splitTextBlock(value: string): readonly string[] {
  const paragraphs = value.replaceAll('\r\n', '\n').split(/\n\s*\n+/u).map(item => item.trim()).filter(Boolean)
  return paragraphs.flatMap(splitParagraph)
}

function splitParagraph(paragraph: string): readonly string[] {
  if (paragraph.length <= CHUNK_CHARACTER_LIMIT) return [paragraph]
  const sentences = paragraph.split(/(?<=[。！？!?])\s+|(?<=[.!?])\s+(?=[A-Z0-9])/u).map(item => item.trim()).filter(Boolean)
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const sentencePieces = sentence.length <= CHUNK_CHARACTER_LIMIT ? [sentence] : hardSplit(sentence, CHUNK_CHARACTER_LIMIT)
    for (const piece of sentencePieces) {
      if (current !== '' && current.length + piece.length + 1 > CHUNK_CHARACTER_LIMIT) {
        pieces.push(current)
        current = ''
      }
      current = current === '' ? piece : `${current} ${piece}`
    }
  }
  if (current !== '') pieces.push(current)
  return pieces
}

function hardSplit(value: string, limit: number): readonly string[] {
  const pieces: string[] = []
  let remaining = value.trim()
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit + 1).lastIndexOf(' ')
    const cut = candidate >= Math.floor(limit * 0.6) ? candidate : limit
    pieces.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining !== '') pieces.push(remaining)
  return pieces
}

class MarkdownIndex {
  private readonly lines: readonly string[]
  private readonly normalizedLines: readonly string[]
  private cursor = 0

  constructor(markdown: string) {
    this.lines = markdown.replaceAll('\r\n', '\n').split('\n')
    this.normalizedLines = this.lines.map(normalizeText)
  }

  locate(content: string): { readonly lineStart: number; readonly lineEnd: number } {
    const needle = normalizeText(content)
    const terms = needle.split(' ').filter(term => term.length >= 4).slice(0, 6)
    const found = this.findLine(needle, terms)
    const start = found ?? Math.min(this.cursor, Math.max(this.lines.length - 1, 0))
    const span = Math.max(1, Math.min(40, Math.ceil(content.split('\n').length + content.length / 180)))
    if (found !== undefined) this.cursor = Math.max(this.cursor, start)
    return { lineStart: start + 1, lineEnd: Math.min(this.lines.length, start + span) }
  }

  private findLine(needle: string, terms: readonly string[]): number | undefined {
    const scan = (from: number, exactOnly: boolean): number | undefined => {
      for (let offset = from; offset < this.normalizedLines.length; offset += 1) {
        const line = this.normalizedLines[offset] ?? ''
        if (needle !== '' && (line === needle || (!exactOnly && (line.includes(needle) || (line.length >= 12 && needle.includes(line)))))) return offset
        if (!exactOnly && terms.length > 0 && terms.filter(term => line.includes(term)).length >= Math.min(2, terms.length)) return offset
      }
      return undefined
    }
    // Prefer a forward exact match, then a forward fuzzy match. A full-file
    // fallback is necessary because MinerU may emit blocks whose text order
    // differs slightly from the final Markdown order.
    return scan(this.cursor, true) ?? scan(this.cursor, false) ?? scan(0, true) ?? scan(0, false)
  }
}
