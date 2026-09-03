/** SQLite-backed local domain store for libraries, papers, and parsed assets. */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { EmbeddingJobRecord, EmbeddingJobStatus, FigureVisionStatus, LibraryRecord, PaperBibliographyEntry, PaperCitation, PaperChunkRecord, PaperElementCitation, PaperElementRead, PaperElementRecord, PaperElementType, PaperEmbeddingSource, PaperFigureCitation, PaperFigureRecord, PaperParseStructure, PaperRecord, PaperReferenceRecord, PaperSearchFilter, PaperSectionOutline, PaperSectionRead, PaperSectionRecord, ParseJobRecord, ParseJobStatus, ParseStatus, VisionJobRecord, VisionJobStatus } from './models.ts'

import type {
  CreateLibraryInput,
  CreatePaperFigureInput,
  CreatePaperFromBibtexInput,
  FindInPaperMarkdownInput,
  ImportPaperInput,
  MovePaperInput,
  ReadPaperElementInput,
  ReadPaperSectionInput,
  ReplacePaperPdfInput,
  SearchPaperElementsInput,
  UpdatePaperMetadataInput,
  PaperAgentStoreOptions,
} from './inputs.ts'
export type {
  CreateLibraryInput,
  CreatePaperFigureInput,
  CreatePaperFromBibtexInput,
  FindInPaperMarkdownInput,
  ImportPaperInput,
  MovePaperInput,
  ReadPaperElementInput,
  ReadPaperSectionInput,
  ReplacePaperPdfInput,
  SearchPaperElementsInput,
  UpdatePaperMetadataInput,
  PaperAgentStoreOptions,
} from './inputs.ts'
import type { PaperRow } from './rows.ts'
import { initializeSchema } from './schema.ts'
import { normalizeAuthors, normalizeYear, normalizedTitle, nullableText, optionalText } from './normalizers.ts'
import { parseBibtexMetadata } from './bibtex.ts'
import { toPaperRecord } from './row-mappers.ts'
import { createLibrary as createLibraryRepository, deleteLibrary as deleteLibraryRepository, listLibraries as listLibrariesRepository, renameLibrary as renameLibraryRepository } from './repositories/library-repository.ts'
import { getPaper as getPaperRepository, insertPaper as insertPaperRepository, listPapers as listPapersRepository, readPaperBibliography as readPaperBibliographyRepository } from './repositories/paper-repository.ts'
import { canonicalWorkspace, paperArtifactPaths, workspaceDataPath } from './paths.ts'
export { canonicalWorkspace, paperArtifactPaths, workspaceDataPath } from './paths.ts'
import { requireNonBlank } from './validation.ts'
import { createParseJob as createParseJobRepository, findActiveParseJob as findActiveParseJobRepository, getParseJob as getParseJobRepository, recoverParseJobs as recoverParseJobsRepository, updateParseJob as updateParseJobRepository } from './repositories/parse-job-repository.ts'
import { createVisionJob as createVisionJobRepository, findActiveVisionJob as findActiveVisionJobRepository, getVisionJob as getVisionJobRepository, recoverVisionJobs as recoverVisionJobsRepository, updateVisionJob as updateVisionJobRepository } from './repositories/vision-job-repository.ts'
import { findInPaperMarkdown as findInPaperMarkdownRepository, listPaperSections as listPaperSectionsRepository, readPaperSection as readPaperSectionRepository } from './repositories/markdown-repository.ts'
import { getPaperChunkCitationsByIds as getPaperChunkCitationsByIdsRepository, getPaperElementCitationsByIds as getPaperElementCitationsByIdsRepository, getPaperFigureCitationsByElementIds as getPaperFigureCitationsByElementIdsRepository, readPaperElement as readPaperElementRepository, searchPaperChunks as searchPaperChunksRepository, searchPaperElements as searchPaperElementsRepository, searchPaperFigures as searchPaperFiguresRepository } from './repositories/search-repository.ts'
import { findReusableFigureVision as findReusableFigureVisionRepository, getPaperFigure as getPaperFigureRepository, listPaperFigures as listPaperFiguresRepository, replacePaperFigures as replacePaperFiguresRepository, setPaperFigureVisionStatus as setPaperFigureVisionStatusRepository } from './repositories/figure-repository.ts'
import { replacePaperChunks as replacePaperChunksRepository } from './repositories/index-repository.ts'
import { getPaperParseStructure as getPaperParseStructureRepository } from './repositories/parse-structure-repository.ts'
import { getPaperReference as getPaperReferenceRepository, listPaperReferences as listPaperReferencesRepository, replacePaperReferences as replacePaperReferencesRepository } from './repositories/reference-repository.ts'
import { createEmbeddingJob as createEmbeddingJobRepository, getEmbeddingJob as getEmbeddingJobRepository, listEmbeddingSources as listEmbeddingSourcesRepository, recoverEmbeddingJobs as recoverEmbeddingJobsRepository, restartEmbeddingJob as restartEmbeddingJobRepository, updateEmbeddingJob as updateEmbeddingJobRepository } from './repositories/embedding-repository.ts'
/**
 * Stores only local PaperAgent domain records. DSH session history remains in
 * its own SQLite database and must never be mixed with this schema.
 */
export class PaperAgentStore {
  private readonly db: DatabaseSync
  private readonly options: PaperAgentStoreOptions
  private readonly fts5Enabled: boolean

  private constructor(options: PaperAgentStoreOptions, database: DatabaseSync, fts5Enabled: boolean) {
    this.options = options
    this.db = database
    this.fts5Enabled = fts5Enabled
  }

  /** Opens the local database and creates the PaperAgent schema once. */
  static async open(options: PaperAgentStoreOptions): Promise<PaperAgentStore> {
    const databasePath = resolve(options.databasePath)
    await mkdir(dirname(databasePath), { recursive: true })
    const db = new DatabaseSync(databasePath)
    const fts5Enabled = initializeSchema(db)
    return new PaperAgentStore(options, db, fts5Enabled)
  }

  /** Closes the owned SQLite connection. */
  close(): void {
    this.db.close()
  }

  /** Creates one library within a canonical workspace path. */
  createLibrary(input: CreateLibraryInput): LibraryRecord {
    return createLibraryRepository(this.db, input)
  }

  /** Lists libraries in creation order for one workspace. */
  listLibraries(workspacePath: string): LibraryRecord[] {
    return listLibrariesRepository(this.db, workspacePath)
  }

  /**
   * Removes a library classification without deleting its papers or their
   * managed files. Papers move back to the workspace's unclassified list.
   */
  deleteLibrary(workspacePath: string, libraryId: string): void {
    deleteLibraryRepository(this.db, workspacePath, libraryId)
  }

  /** Renames one library after proving it belongs to the active workspace. */
  renameLibrary(workspacePath: string, libraryId: string, name: string): LibraryRecord {
    return renameLibraryRepository(this.db, workspacePath, libraryId, name)
  }

  /** Lists paper records without reading the original PDF or parsed Markdown. */
  listPapers(workspacePath: string, libraryId?: string | null): PaperRecord[] {
    return listPapersRepository(this.db, workspacePath, libraryId)
  }

  /** Gets a single paper record, or throws when it is not owned by this project. */
  getPaper(workspacePath: string, paperId: string): PaperRecord {
    return getPaperRepository(this.db, workspacePath, paperId)
  }

  /**
   * Reads import-backed bibliography information for LaTeX workflows. This is
   * intentionally workspace-scoped and bounded: it cannot read arbitrary
   * project files or fabricate a citation key from incomplete metadata.
   */
  readPaperBibliography(workspacePath: string, paperIds: readonly string[]): PaperBibliographyEntry[] {
    return readPaperBibliographyRepository(this.db, workspacePath, paperIds)
  }

  /**
   * Copies an approved local PDF into the workspace-managed directory. A hash
   * duplicate returns the existing record and never creates a second copy.
   */
  async importPaper(input: ImportPaperInput): Promise<{ paper: PaperRecord; duplicate: boolean }> {
    const workspacePath = canonicalWorkspace(input.workspacePath)
    const workspaceInfo = await stat(workspacePath)
    if (!workspaceInfo.isDirectory()) throw new Error('paper workspace must be a directory')
    if (input.libraryId !== undefined) this.assertLibrary(workspacePath, input.libraryId)

    const sourceBytes = await this.readValidatedPdf(input.sourcePath)
    const fileHash = createHash('sha256').update(sourceBytes).digest('hex')
    const duplicate = this.db.prepare('SELECT * FROM papers WHERE workspace_path = ? AND file_hash = ?')
      .get(workspacePath, fileHash) as PaperRow | undefined
    if (duplicate !== undefined) return { paper: toPaperRecord(duplicate), duplicate: true }

    const now = new Date().toISOString()
    const id = randomUUID()
    const relativeDir = join('papers', id).replaceAll('\\', '/')
    const directory = workspaceDataPath(workspacePath, relativeDir)
    const targetPath = join(directory, 'original.pdf')
    const paper: PaperRecord = {
      id,
      workspacePath,
      libraryId: input.libraryId ?? null,
      // Browser uploads are staged under a random temporary filename. Prefer
      // the caller's original filename so the generated title is meaningful.
      title: normalizedTitle(input.title, input.originalFileName ?? basename(input.sourcePath)),
      authors: normalizeAuthors(input.authors),
      year: input.year ?? null,
      doi: optionalText(input.doi),
      bibtex: optionalText(input.bibtex),
      citationKey: null,
      journal: null,
      volume: null,
      issue: null,
      pages: null,
      url: null,
      abstract: null,
      keywords: null,
      pdfSourceUrl: null,
      bibtexSourceUrl: null,
      sourceAdapter: null,
      metadataProvenance: [],
      fileHash,
      relativeDir,
      originalFileName: input.originalFileName === undefined
        ? basename(input.sourcePath)
        : basename(requireNonBlank(input.originalFileName, 'original file name')),
      parseStatus: 'queued',
      parseError: null,
      parserVersion: null,
      parseRevision: null,
      parsedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    await mkdir(directory, { recursive: true })
    try {
      await copyFile(input.sourcePath, `${targetPath}.tmp`)
      await rename(`${targetPath}.tmp`, targetPath)
      insertPaperRepository(this.db, paper)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    return { paper, duplicate: false }
  }

  /** Creates a metadata-only paper from one BibTeX entry; a PDF may be attached later. */
  createPaperFromBibtex(input: CreatePaperFromBibtexInput): { paper: PaperRecord; duplicate: boolean } {
    const workspacePath = canonicalWorkspace(input.workspacePath)
    const bibtex = requireNonBlank(input.bibtex, 'BibTeX')
    if (input.libraryId !== undefined) this.assertLibrary(workspacePath, input.libraryId)
    const fileHash = `bibtex:${createHash('sha256').update(bibtex).digest('hex')}`
    const duplicate = this.db.prepare('SELECT * FROM papers WHERE workspace_path = ? AND file_hash = ?')
      .get(workspacePath, fileHash) as PaperRow | undefined
    if (duplicate !== undefined) return { paper: toPaperRecord(duplicate), duplicate: true }
    const now = new Date().toISOString()
    const id = randomUUID()
    const parsed = parseBibtexMetadata(bibtex)
    const paper: PaperRecord = {
      id, workspacePath, libraryId: input.libraryId ?? null,
      title: parsed.title ?? '未命名文献', authors: parsed.authors, year: parsed.year, doi: parsed.doi, bibtex,
      citationKey: parsed.citationKey, journal: parsed.journal, volume: parsed.volume, issue: parsed.issue,
      pages: parsed.pages, url: parsed.url, abstract: parsed.abstract, keywords: parsed.keywords,
      pdfSourceUrl: null, bibtexSourceUrl: null, sourceAdapter: null, metadataProvenance: [],
      fileHash, relativeDir: join('papers', id).replaceAll('\\', '/'), originalFileName: '',
      parseStatus: 'metadata', parseError: null, parserVersion: null, parseRevision: null, parsedAt: null, createdAt: now, updatedAt: now,
    }
    insertPaperRepository(this.db, paper)
    return { paper, duplicate: false }
  }

  /** Atomically replaces/attaches a PDF and clears the active parse revision until a new parse succeeds. */
  async replacePaperPdf(input: ReplacePaperPdfInput): Promise<PaperRecord> {
    const paper = this.getPaper(input.workspacePath, input.paperId)
    const sourceBytes = await this.readValidatedPdf(input.sourcePath)
    const fileHash = createHash('sha256').update(sourceBytes).digest('hex')
    const duplicate = this.db.prepare('SELECT id FROM papers WHERE workspace_path = ? AND file_hash = ? AND id != ?')
      .get(paper.workspacePath, fileHash, paper.id)
    if (duplicate !== undefined) throw new Error('an identical PDF already belongs to another paper in this workspace')
    const paths = paperArtifactPaths(paper)
    await mkdir(paths.directory, { recursive: true })
    const temporaryPath = `${paths.pdf}.${randomUUID()}.tmp`
    await copyFile(input.sourcePath, temporaryPath)
    await rename(temporaryPath, paths.pdf)
    const now = new Date().toISOString()
    const fileName = input.originalFileName === undefined ? basename(input.sourcePath) : basename(requireNonBlank(input.originalFileName, 'original file name'))
    this.db.prepare(`
      UPDATE papers SET file_hash = ?, original_file_name = ?, parse_status = 'queued', parse_error = NULL, parse_revision = NULL, updated_at = ?
      WHERE id = ? AND workspace_path = ?
    `).run(fileHash, fileName, now, paper.id, paper.workspacePath)
    return this.getPaper(paper.workspacePath, paper.id)
  }

  /** Updates the durable parse lifecycle after a parser attempt. */
  setParseStatus(
    workspacePath: string,
    paperId: string,
    status: ParseStatus,
    details: { readonly error?: string; readonly parserVersion?: string } = {},
  ): PaperRecord {
    const paper = this.getPaper(workspacePath, paperId)
    const now = new Date().toISOString()
    const parseError = status === 'failed' ? requireNonBlank(details.error ?? 'unknown parser failure', 'parse error') : null
    const parsedAt = status === 'ready' ? now : paper.parsedAt
    this.db.prepare(`
      UPDATE papers
      SET parse_status = ?, parse_error = ?, parser_version = ?, parsed_at = ?, updated_at = ?
      WHERE id = ? AND workspace_path = ?
    `).run(status, parseError, details.parserVersion ?? paper.parserVersion, parsedAt, now, paperId, paper.workspacePath)
    return this.getPaper(workspacePath, paperId)
  }

  /** Updates user-editable bibliography and paper metadata only. */
  updatePaperMetadata(input: UpdatePaperMetadataInput): PaperRecord {
    const paper = this.getPaper(input.workspacePath, input.paperId)
    const patch = input.patch
    // A BibTeX file is an authoritative metadata source when it is uploaded on
    // its own.  Previously this method persisted only the raw BibTeX, so the
    // edit dialog kept showing the old title/authors/year.  Explicit fields in
    // the same request remain user edits and therefore take precedence.
    const parsedBibtex = patch.bibtex === undefined || patch.bibtex === null
      ? null
      : parseBibtexMetadata(patch.bibtex)
    const next: PaperRecord = {
      ...paper,
      ...(patch.title === undefined
        ? parsedBibtex?.title === null || parsedBibtex === null ? {} : { title: parsedBibtex.title }
        : { title: requireNonBlank(patch.title, 'paper title') }),
      ...(patch.authors === undefined
        ? parsedBibtex === null || parsedBibtex.authors.length === 0 ? {} : { authors: parsedBibtex.authors }
        : { authors: normalizeAuthors(patch.authors) }),
      ...(patch.year === undefined
        ? parsedBibtex?.year === null || parsedBibtex === null ? {} : { year: parsedBibtex.year }
        : { year: normalizeYear(patch.year) }),
      ...(patch.doi === undefined
        ? parsedBibtex?.doi === null || parsedBibtex === null ? {} : { doi: parsedBibtex.doi }
        : { doi: nullableText(patch.doi) }),
      ...(patch.bibtex === undefined ? {} : { bibtex: nullableText(patch.bibtex) }),
      ...(patch.citationKey === undefined
        ? parsedBibtex?.citationKey === null || parsedBibtex === null ? {} : { citationKey: parsedBibtex.citationKey }
        : { citationKey: nullableText(patch.citationKey) }),
      ...(patch.journal === undefined
        ? parsedBibtex?.journal === null || parsedBibtex === null ? {} : { journal: parsedBibtex.journal }
        : { journal: nullableText(patch.journal) }),
      ...(patch.volume === undefined
        ? parsedBibtex?.volume === null || parsedBibtex === null ? {} : { volume: parsedBibtex.volume }
        : { volume: nullableText(patch.volume) }),
      ...(patch.issue === undefined
        ? parsedBibtex?.issue === null || parsedBibtex === null ? {} : { issue: parsedBibtex.issue }
        : { issue: nullableText(patch.issue) }),
      ...(patch.pages === undefined
        ? parsedBibtex?.pages === null || parsedBibtex === null ? {} : { pages: parsedBibtex.pages }
        : { pages: nullableText(patch.pages) }),
      ...(patch.url === undefined
        ? parsedBibtex?.url === null || parsedBibtex === null ? {} : { url: parsedBibtex.url }
        : { url: nullableText(patch.url) }),
      ...(patch.abstract === undefined
        ? parsedBibtex?.abstract === null || parsedBibtex === null ? {} : { abstract: parsedBibtex.abstract }
        : { abstract: nullableText(patch.abstract) }),
      ...(patch.keywords === undefined
        ? parsedBibtex?.keywords === null || parsedBibtex === null ? {} : { keywords: parsedBibtex.keywords }
        : { keywords: nullableText(patch.keywords) }),
      updatedAt: new Date().toISOString(),
    }
    this.db.prepare(`
      UPDATE papers SET title = ?, authors = ?, year = ?, doi = ?, bibtex = ?, citation_key = ?, journal = ?,
        volume = ?, issue = ?, pages = ?, url = ?, abstract = ?, keywords = ?, updated_at = ?
      WHERE id = ? AND workspace_path = ?
    `).run(
      next.title, JSON.stringify(next.authors), next.year, next.doi, next.bibtex, next.citationKey, next.journal,
      next.volume, next.issue, next.pages, next.url, next.abstract, next.keywords, next.updatedAt,
      next.id, next.workspacePath,
    )
    return this.getPaper(next.workspacePath, next.id)
  }

  /** Stores acquisition evidence that is owned by import code, never by free-form metadata editing. */
  setPaperImportProvenance(input: {
    readonly workspacePath: string
    readonly paperId: string
    readonly pdfSourceUrl: string | null
    readonly bibtexSourceUrl: string | null
    readonly sourceAdapter: string | null
    readonly metadataProvenance: readonly { readonly source: string; readonly url: string }[]
  }): PaperRecord {
    const paper = this.getPaper(input.workspacePath, input.paperId)
    const updatedAt = new Date().toISOString()
    this.db.prepare(`
      UPDATE papers
      SET pdf_source_url = ?, bibtex_source_url = ?, source_adapter = ?, metadata_provenance_json = ?, updated_at = ?
      WHERE id = ? AND workspace_path = ?
    `).run(
      input.pdfSourceUrl, input.bibtexSourceUrl, input.sourceAdapter, JSON.stringify(input.metadataProvenance), updatedAt,
      paper.id, paper.workspacePath,
    )
    return this.getPaper(paper.workspacePath, paper.id)
  }

  /** Returns the newest active parse attempt for a paper, if any. */
  findActiveParseJob(workspacePath: string, paperId: string): ParseJobRecord | undefined {
    return findActiveParseJobRepository(this.db, workspacePath, paperId)
  }

  createParseJob(workspacePath: string, paperId: string, id = randomUUID()): ParseJobRecord {
    const paper = this.getPaper(workspacePath, paperId)
    return createParseJobRepository(this.db, paper, (workspace, currentPaperId, status) => {
      this.setParseStatus(workspace, currentPaperId, status)
    }, id)
  }

  getParseJob(workspacePath: string, jobId: string): ParseJobRecord {
    return getParseJobRepository(this.db, workspacePath, jobId)
  }

  updateParseJob(workspacePath: string, jobId: string, patch: {
    readonly status?: ParseJobStatus
    readonly currentPage?: number | null
    readonly totalPages?: number | null
    readonly chunkCount?: number | null
    readonly error?: string | null
    readonly startedAt?: string | null
    readonly finishedAt?: string | null
  }): ParseJobRecord {
    return updateParseJobRepository(this.db, workspacePath, jobId, patch)
  }

  /** Requeues interrupted jobs; MinerU batch state is not durable, so retry safely starts a fresh parse. */
  recoverParseJobs(): ParseJobRecord[] {
    return recoverParseJobsRepository(this.db, (workspace, paperId, status) => {
      this.setParseStatus(workspace, paperId, status)
    })
  }

  findActiveVisionJob(workspacePath: string, figureId: string): VisionJobRecord | undefined {
    return findActiveVisionJobRepository(this.db, workspacePath, figureId)
  }

  createVisionJob(workspacePath: string, figureId: string, id = randomUUID()): VisionJobRecord {
    const figure = this.getPaperFigure(workspacePath, figureId)
    return createVisionJobRepository(this.db, figure, id)
  }

  getVisionJob(workspacePath: string, jobId: string): VisionJobRecord {
    return getVisionJobRepository(this.db, workspacePath, jobId)
  }

  updateVisionJob(workspacePath: string, jobId: string, patch: {
    readonly status?: VisionJobStatus
    readonly error?: string | null
    readonly startedAt?: string | null
    readonly finishedAt?: string | null
  }): VisionJobRecord {
    return updateVisionJobRepository(this.db, workspacePath, jobId, patch)
  }

  /** Requeues visual work interrupted by a host restart and resets its figure state. */
  recoverVisionJobs(): VisionJobRecord[] {
    return recoverVisionJobsRepository(this.db, (workspace, figureId, status) => {
      this.setPaperFigureVisionStatus(workspace, figureId, status)
    })
  }

  /**
   * Reclassifies a paper within its active workspace. This deliberately does
   * not touch the PDF, Markdown, chunks, figures, or parse state.
   */
  movePaper(input: MovePaperInput): PaperRecord {
    const paper = this.getPaper(input.workspacePath, input.paperId)
    if (input.libraryId !== null) this.assertLibrary(paper.workspacePath, input.libraryId)
    const updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE papers SET library_id = ?, updated_at = ? WHERE id = ? AND workspace_path = ?')
      .run(input.libraryId, updatedAt, paper.id, paper.workspacePath)
    return this.getPaper(paper.workspacePath, paper.id)
  }

  /** Deletes one paper, its searchable chunks, and its owned local artifacts. */
  async deletePaper(workspacePath: string, paperId: string): Promise<void> {
    const paper = this.getPaper(workspacePath, paperId)
    this.withImmediateTransaction(() => {
      if (this.fts5Enabled) {
        this.db.prepare('DELETE FROM paper_chunks_fts WHERE workspace_path = ? AND paper_id = ?')
          .run(paper.workspacePath, paper.id)
        this.db.prepare('DELETE FROM paper_elements_fts WHERE workspace_path = ? AND paper_id = ?')
          .run(paper.workspacePath, paper.id)
        this.db.prepare('DELETE FROM paper_figures_fts WHERE workspace_path = ? AND paper_id = ?')
          .run(paper.workspacePath, paper.id)
      }
      this.db.prepare('DELETE FROM papers WHERE id = ? AND workspace_path = ?').run(paper.id, paper.workspacePath)
    })
    await rm(workspaceDataPath(paper.workspacePath, paper.relativeDir), { recursive: true, force: true })
  }

  /** Replaces every searchable citation interval after a successful parse. */
  replacePaperChunks(
    workspacePath: string,
    paperId: string,
    chunks: readonly PaperChunkRecord[],
    elements: readonly PaperElementRecord[] = [],
    manageTransaction = true,
    sections: readonly PaperSectionRecord[] = [],
  ): void {
    replacePaperChunksRepository(this.db, this.fts5Enabled, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId, chunks, elements, manageTransaction, sections)
  }

  /**
   * Performs deterministic local lexical retrieval. It intentionally keeps the
   * returned page and line coordinates so an agent cannot cite a made-up source.
   */
  searchPaperChunks(workspacePath: string, query: string, limit = 6, filter: PaperSearchFilter = {}): PaperCitation[] {
    return searchPaperChunksRepository(this.db, this.fts5Enabled, workspacePath, query, limit, filter)
  }

  /** Hydrates bounded externally ranked chunk ids from the current local parse revision. */
  getPaperChunkCitationsByIds(workspacePath: string, chunkIds: readonly string[], filter: PaperSearchFilter = {}): PaperCitation[] {
    return getPaperChunkCitationsByIdsRepository(this.db, workspacePath, chunkIds, filter)
  }

  /** Hydrates bounded externally ranked element ids from current local facts. */
  getPaperElementCitationsByIds(input: {
    readonly workspacePath: string
    readonly elementIds: readonly string[]
    readonly types?: readonly PaperElementType[]
    readonly filter?: PaperSearchFilter
  }): PaperElementCitation[] {
    return getPaperElementCitationsByIdsRepository(this.db, input.workspacePath, input.elementIds, {
      ...(input.types === undefined ? {} : { types: input.types }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
    })
  }

  /** Searches structured figures, tables, equations, and other elements. */
  searchPaperElements(input: SearchPaperElementsInput): PaperElementCitation[] {
    return searchPaperElementsRepository(this.db, this.fts5Enabled, input)
  }

  /** Lists bibliography entries extracted from one parsed PDF. */
  listPaperReferences(workspacePath: string, paperId: string): PaperReferenceRecord[] {
    return listPaperReferencesRepository(this.db, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId)
  }

  /** Reads one bibliography entry by the ordinal printed by the source paper. */
  getPaperReference(workspacePath: string, paperId: string, ordinal: number): PaperReferenceRecord {
    return getPaperReferenceRepository(this.db, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId, ordinal)
  }

  /** Reads one bounded structured element from the active workspace. */
  readPaperElement(input: ReadPaperElementInput): PaperElementRead {
    return readPaperElementRepository(this.db, input)
  }

  /** Reads a bounded set of exact Markdown matches from one owned paper only. */
  async findInPaperMarkdown(input: FindInPaperMarkdownInput): Promise<PaperCitation[]> {
    return findInPaperMarkdownRepository(this.db, input, (workspace, paperId) => this.getPaper(workspace, paperId))
  }

  /** Lists the exact readable section titles for one paper; never reads arbitrary files. */
  listPaperSections(workspacePath: string, paperId: string): PaperSectionOutline[] {
    return listPaperSectionsRepository(this.db, workspacePath, paperId, (workspace, id) => this.getPaper(workspace, id))
  }

  /** Returns the active parsed section tree with bounded child-chunk previews. */
  getPaperParseStructure(workspacePath: string, paperId: string): PaperParseStructure {
    return getPaperParseStructureRepository(this.db, workspacePath, paperId, (workspace, id) => this.getPaper(workspace, id))
  }

  /** Reads one small, citeable Markdown interval from a paper owned by this workspace. */
  async readPaperSection(input: ReadPaperSectionInput): Promise<PaperSectionRead> {
    return readPaperSectionRepository(this.db, input, (workspace, paperId) => this.getPaper(workspace, paperId))
  }

  /** Atomically replaces figure metadata after a successful MinerU parse. */
  replacePaperFigures(workspacePath: string, paperId: string, figures: readonly CreatePaperFigureInput[], manageTransaction = true): PaperFigureRecord[] {
    return replacePaperFiguresRepository(this.db, this.fts5Enabled, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId, figures, manageTransaction)
  }

  /**
   * Commits every derived SQLite record from one parser revision together.
   * Callers must make the corresponding file revision visible only after this
   * method succeeds, so readers never observe mixed old/new search indexes.
   */
  replacePaperParseIndex(
    workspacePath: string,
    paperId: string,
    chunks: readonly PaperChunkRecord[],
    elements: readonly PaperElementRecord[],
    figures: readonly CreatePaperFigureInput[],
    sections: readonly PaperSectionRecord[] = [],
    references: readonly PaperReferenceRecord[] = [],
  ): PaperFigureRecord[] {
    return this.withImmediateTransaction(() => {
      this.replacePaperChunks(workspacePath, paperId, chunks, elements, false, sections)
      replacePaperReferencesRepository(this.db, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId, references, false)
      const records = this.replacePaperFigures(workspacePath, paperId, figures, false)
      return records
    })
  }

  /**
   * Makes one immutable artifact revision visible with its derived indexes.
   * The parser must have already renamed the fully written staging directory to
   * `revisions/<revision>` before calling this method. If SQLite rejects any
   * derived record, no reader can observe that directory because the revision
   * pointer and all indexes roll back together.
   */
  commitPaperParseRevision(
    workspacePath: string,
    paperId: string,
    revision: string,
    chunks: readonly PaperChunkRecord[],
    elements: readonly PaperElementRecord[],
    figures: readonly CreatePaperFigureInput[],
    parserVersion: string,
    sections: readonly PaperSectionRecord[] = [],
    references: readonly PaperReferenceRecord[] = [],
  ): PaperRecord {
    const paper = this.getPaper(workspacePath, paperId)
    const safeRevision = requireNonBlank(revision, 'parse revision')
    if (!/^[a-zA-Z0-9-]+$/.test(safeRevision)) throw new Error('parse revision contains unsupported characters')
    const now = new Date().toISOString()
    this.withImmediateTransaction(() => {
      this.replacePaperChunks(paper.workspacePath, paper.id, chunks, elements, false, sections)
      replacePaperReferencesRepository(this.db, (workspace, id) => this.getPaper(workspace, id), paper.workspacePath, paper.id, references, false)
      this.replacePaperFigures(paper.workspacePath, paper.id, figures, false)
      this.db.prepare(`
        UPDATE papers
        SET parse_status = 'ready', parse_error = NULL, parser_version = ?, parse_revision = ?, parsed_at = ?, updated_at = ?
        WHERE id = ? AND workspace_path = ?
      `).run(parserVersion, safeRevision, now, now, paper.id, paper.workspacePath)
    })
    return this.getPaper(paper.workspacePath, paper.id)
  }

  listPaperFigures(workspacePath: string, paperId: string): PaperFigureRecord[] {
    return listPaperFiguresRepository(this.db, (workspace, id) => this.getPaper(workspace, id), workspacePath, paperId)
  }

  getPaperFigure(workspacePath: string, figureId: string): PaperFigureRecord {
    return getPaperFigureRepository(this.db, workspacePath, figureId)
  }

  setPaperFigureVisionStatus(workspacePath: string, figureId: string, status: FigureVisionStatus, details: {
    readonly description?: string
    readonly model?: string
    readonly promptVersion?: string
    readonly error?: string
  } = {}): PaperFigureRecord {
    return setPaperFigureVisionStatusRepository(this.db, this.fts5Enabled, workspacePath, figureId, status, details)
  }

  searchPaperFigures(workspacePath: string, query: string, limit = 6): PaperFigureCitation[] {
    return searchPaperFiguresRepository(this.db, this.fts5Enabled, workspacePath, query, limit)
  }

  /** Hydrates vectorised element ids as owned current figure citations. */
  getPaperFigureCitationsByElementIds(workspacePath: string, elementIds: readonly string[]): PaperFigureCitation[] {
    return getPaperFigureCitationsByElementIdsRepository(this.db, workspacePath, elementIds)
  }

  /** Reuses an already validated description for identical local image bytes. */
  findReusableFigureVision(workspacePath: string, sha256: string, excludeFigureId?: string): PaperFigureRecord | undefined {
    return findReusableFigureVisionRepository(this.db, workspacePath, sha256, excludeFigureId)
  }

  /** Creates idempotent derived-index work only after the parse revision is durable. */
  createEmbeddingJob(workspacePath: string, paperId: string, input: { readonly provider: string; readonly model: string; readonly dimensions: number }): EmbeddingJobRecord {
    const paper = this.getPaper(workspacePath, paperId)
    const totalItems = this.listEmbeddingSources(workspacePath, paperId).length
    return createEmbeddingJobRepository(this.db, paper, { ...input, totalItems })
  }

  /** Rebuilds the current parsed revision without changing source PDF or parse data. */
  restartEmbeddingJob(workspacePath: string, paperId: string, input: { readonly provider: string; readonly model: string; readonly dimensions: number }): EmbeddingJobRecord {
    const paper = this.getPaper(workspacePath, paperId)
    const totalItems = this.listEmbeddingSources(workspacePath, paperId).length
    return restartEmbeddingJobRepository(this.db, paper, { ...input, totalItems })
  }

  getEmbeddingJob(workspacePath: string, jobId: string): EmbeddingJobRecord {
    return getEmbeddingJobRepository(this.db, workspacePath, jobId)
  }

  updateEmbeddingJob(workspacePath: string, jobId: string, patch: {
    readonly status?: EmbeddingJobStatus; readonly completedItems?: number; readonly error?: string | null
    readonly retryCount?: number; readonly startedAt?: string | null; readonly finishedAt?: string | null
  }): EmbeddingJobRecord {
    return updateEmbeddingJobRepository(this.db, workspacePath, jobId, patch)
  }

  recoverEmbeddingJobs(): EmbeddingJobRecord[] { return recoverEmbeddingJobsRepository(this.db) }

  /** Rebuilds embedding inputs from current source-map facts; no vector is stored in SQLite. */
  listEmbeddingSources(workspacePath: string, paperId: string): PaperEmbeddingSource[] {
    return listEmbeddingSourcesRepository(this.db, this.getPaper(workspacePath, paperId))
  }

  getVectorSettings(): { embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean } {
    const rows = this.db.prepare("SELECT key, value FROM paperagent_settings WHERE key IN ('embeddingEnabled', 'elasticsearchEnabled', 'rerankerEnabled')").all() as unknown as Array<{ key: string; value: string }>
    const values = new Map(rows.map(row => [row.key, row.value === 'true']))
    return {
      embeddingEnabled: values.get('embeddingEnabled') ?? false,
      elasticsearchEnabled: values.get('elasticsearchEnabled') ?? false,
      rerankerEnabled: values.get('rerankerEnabled') ?? false,
    }
  }

  setVectorSettings(next: { embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean }): { embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean } {
    const now = new Date().toISOString(); const write = this.db.prepare("INSERT INTO paperagent_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    this.withImmediateTransaction(() => {
      write.run('embeddingEnabled', String(next.embeddingEnabled), now)
      write.run('elasticsearchEnabled', String(next.elasticsearchEnabled), now)
      write.run('rerankerEnabled', String(next.rerankerEnabled), now)
    })
    return this.getVectorSettings()
  }

  getPaperEmbeddingStatus(workspacePath: string, paperId: string) {
    const paper = this.getPaper(workspacePath, paperId)
    // An embedding job belongs to one immutable parse revision. Never expose
    // the previous revision's `ready` state while a replacement PDF is queued
    // or a new parse is still in progress.
    if (paper.parseStatus !== 'ready' || paper.parseRevision === null) return { status: 'not_indexed', totalItems: 0, completedItems: 0, error: null }
    const row = this.db.prepare("SELECT status, total_items, completed_items, error FROM paper_embedding_jobs WHERE workspace_path = ? AND paper_id = ? AND parse_revision = ? ORDER BY created_at DESC LIMIT 1").get(canonicalWorkspace(workspacePath), paperId, paper.parseRevision) as { status: string; total_items: number; completed_items: number; error: string | null } | undefined
    return row === undefined ? { status: 'not_indexed', totalItems: 0, completedItems: 0, error: null } : { status: row.status, totalItems: row.total_items, completedItems: row.completed_items, error: row.error }
  }

  private assertLibrary(workspacePath: string, libraryId: string): void {
    const row = this.db.prepare('SELECT id FROM libraries WHERE id = ? AND workspace_path = ?').get(libraryId, workspacePath)
    if (row === undefined) throw new Error('library not found in the active workspace')
  }

  private async readValidatedPdf(sourcePath: string): Promise<Buffer> {
    if (extname(sourcePath).toLowerCase() !== '.pdf') throw new Error('only .pdf files can be imported')
    const sourceInfo = await stat(sourcePath)
    if (!sourceInfo.isFile()) throw new Error('paper source must be a file')
    if (sourceInfo.size > this.options.maxPdfBytes) throw new Error(`PDF exceeds the ${this.options.maxPdfBytes}-byte limit`)
    const sourceBytes = await readFile(sourcePath)
    if (!sourceBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('paper source is not a PDF document')
    return sourceBytes
  }

  private withImmediateTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

}
