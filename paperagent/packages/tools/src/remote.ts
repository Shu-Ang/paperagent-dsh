/** Browser-facing PaperAgent BFF. SQLite and managed files stay on the Host. */

import type { Context } from '@deepseek-ai/cordis'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { paperAgentRemoteContract } from '@paperagent/contracts'
import { PaperAgentStore, paperArtifactPaths, safeFigureRelativePath } from '@paperagent/domain'
import type { PaperElementType } from '@paperagent/domain'
import { PaperParseJobs } from './parse-jobs.ts'
import type { PaperEmbeddingJobs } from './embedding-jobs.ts'
import { PaperPdfAccess } from './pdf-access.ts'
import type { PaperVisionJobs } from './vision-jobs.ts'
import { importResolvedCandidate } from './import/paper-import-service.ts'
import { resolvePaperReference } from './import/adapter-registry.ts'
import { writeBrowserPdf } from './browser-upload.ts'
import { toPaperDetail, toPaperSummary } from './remote-mappers.ts'
import { importArxivPaperIntoWorkspace, importPdfUrlIntoWorkspace } from './remote-import.ts'
export { importArxivPaperIntoWorkspace, importPdfUrlIntoWorkspace } from './remote-import.ts'

export interface PaperAgentRemoteConfig {
  readonly store: Promise<PaperAgentStore>
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs?: number
  readonly maxDownloadRedirects?: number
  readonly parseJobs: PaperParseJobs
  readonly embedding?: PaperEmbeddingJobs
  readonly pdfAccess: PaperPdfAccess
  readonly vision?: PaperVisionJobs
  readonly rerankerAvailable?: boolean
  /** Host-only callback: the secret stays inside DSH credentials and never reaches the browser. */
  readonly testElasticsearch?: () => Promise<{ readonly nodeName: string; readonly clusterName: string; readonly version: string }>
}

/**
 * The methods deliberately take a session id instead of a filesystem path.
 * The workspace is resolved from DSH's live Session, so a browser caller
 * cannot point PaperAgent at an arbitrary local directory.
 */
export class PaperAgentRemoteService extends TypertRemoteService {
  static inject = ['agents']

  constructor(ctx: Context, private readonly config: PaperAgentRemoteConfig) {
    super(ctx, 'paperAgent')
  }

  async listLibraries(sessionId: string) {
    const store = await this.config.store
    return store.listLibraries(this.workspaceOf(sessionId)).map(library => ({
      id: library.id, name: library.name, paperCount: library.paperCount, createdAt: library.createdAt, updatedAt: library.updatedAt,
    }))
  }

  async createLibrary(sessionId: string, name: string) {
    const store = await this.config.store
    const library = store.createLibrary({ workspacePath: this.workspaceOf(sessionId), name })
    return { id: library.id, name: library.name, paperCount: library.paperCount, createdAt: library.createdAt, updatedAt: library.updatedAt }
  }

  async renameLibrary(sessionId: string, libraryId: string, name: string) {
    const store = await this.config.store
    const library = store.renameLibrary(this.workspaceOf(sessionId), libraryId, name)
    return {
      id: library.id, name: library.name, paperCount: library.paperCount,
      createdAt: library.createdAt, updatedAt: library.updatedAt,
    }
  }

  async deleteLibrary(sessionId: string, libraryId: string) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    const affectedPaperIds = store.listPapers(workspace, libraryId).map(paper => paper.id)
    store.deleteLibrary(workspace, libraryId)
    // Library membership is stored as a filter field in the rebuildable
    // vector projection. Keep every affected paper aligned when deletion
    // moves it back to the unclassified bucket.
    if (this.config.embedding !== undefined) {
      await this.config.embedding.updatePapersLibrary(workspace, affectedPaperIds, null).catch(error => {
        this.ctx.logger.warn(`paperagent: failed to sync deleted library in vectors: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return { id: libraryId }
  }

  async listPapers(sessionId: string, filter: { libraryId?: string | null }) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    return store.listPapers(workspace, filter.libraryId).map(paper => toPaperSummary(paper, store.getPaperEmbeddingStatus(workspace, paper.id)))
  }

  async getVectorSettings(sessionId: string) {
    this.assertSessionExists(sessionId)
    return {
      ...(await this.config.store).getVectorSettings(),
      rerankerAvailable: this.config.rerankerAvailable === true,
    }
  }

  async setVectorSettings(sessionId: string, input: { embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean }) {
    this.assertSessionExists(sessionId)
    return {
      ...(await this.config.store).setVectorSettings(input),
      rerankerAvailable: this.config.rerankerAvailable === true,
    }
  }

  async getPaper(sessionId: string, paperId: string) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    return toPaperDetail(store.getPaper(workspace, paperId), store.getPaperEmbeddingStatus(workspace, paperId))
  }

  /** Returns the current parsed section tree and bounded child-chunk previews. */
  async getPaperParseStructure(sessionId: string, paperId: string) {
    const store = await this.config.store
    return store.getPaperParseStructure(this.workspaceOf(sessionId), paperId)
  }

  /** Issues an expiring, opaque URL for the current session's one owned PDF. */
  async createPaperPdfAccess(sessionId: string, paperId: string) {
    const workspace = this.workspaceOf(sessionId)
    return this.config.pdfAccess.create(await this.config.store, workspace, paperId)
  }

  /** Tests the configured optional derived-index backend without exposing any credential. */
  async testElasticsearch(sessionId: string) {
    this.assertSessionExists(sessionId)
    if (this.config.testElasticsearch === undefined) {
      throw new Error('Elasticsearch 尚未在 PaperAgent 插件配置中启用。')
    }
    return this.config.testElasticsearch()
  }

  async updatePaperMetadata(
    sessionId: string,
    paperId: string,
    patch: {
      title?: string; authors?: string[]; year?: number | null; doi?: string | null; bibtex?: string | null
      citationKey?: string | null; journal?: string | null; volume?: string | null; issue?: string | null
      pages?: string | null; url?: string | null; abstract?: string | null; keywords?: string | null
    },
  ) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    const paper = store.updatePaperMetadata({ workspacePath: workspace, paperId, patch })
    return toPaperDetail(paper, store.getPaperEmbeddingStatus(workspace, paper.id))
  }

  /** Moves one paper between local libraries without changing its artifacts. */
  async movePaper(sessionId: string, paperId: string, libraryId: string | null) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    const paper = store.movePaper({ workspacePath: workspace, paperId, libraryId })
    await this.config.embedding?.updatePaperLibrary(workspace, paper.id, paper.libraryId).catch(error => {
      // SQLite remains the source of truth. A transient ES outage only makes
      // library-filtered vector recall stale until the next index rebuild;
      // surface it in host logs without failing the local classification.
      this.ctx.logger.warn(`paperagent: failed to sync paper library in vectors: ${error instanceof Error ? error.message : String(error)}`)
    })
    return toPaperDetail(paper, store.getPaperEmbeddingStatus(workspace, paper.id))
  }

  async deletePaper(sessionId: string, paperId: string) {
    const store = await this.config.store
    const workspace = this.workspaceOf(sessionId)
    // Quiesce parse/vision callbacks before cascading the SQLite row. Both
    // workers hold asynchronous network/file continuations which otherwise
    // could write against a paper that has already been deleted.
    await this.config.parseJobs.removePaper(workspace, paperId)
    await this.config.vision?.removePaper(workspace, paperId)
    if (this.config.embedding === undefined) {
      await store.deletePaper(workspace, paperId)
    } else {
      let deleted = false
      try {
        await this.config.embedding.remove(workspace, paperId, async () => {
          await store.deletePaper(workspace, paperId)
          deleted = true
        })
      } catch (error) {
        // SQLite remains authoritative: once the callback succeeded, an
        // Elasticsearch outage must not turn a successful local deletion into
        // a client-visible failure.
        if (!deleted) throw error
        this.ctx.logger.warn(`paperagent: failed to clean deleted paper vectors: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { id: paperId }
  }

  /** Stores one selected PDF and creates a queued record; parsing is a separate job. */
  async uploadPaper(
    sessionId: string,
    input: { fileName: string; base64: string; libraryId: string | null; title?: string },
  ) {
    const workspace = this.workspaceOf(sessionId)
    this.ctx.logger.debug(`paperagent: uploadPaper entered (name=${JSON.stringify(input.fileName)}, base64Chars=${input.base64.length})`)
    try {
      const imported = await this.importBrowserPdf(workspace, input)
      const paper = imported.paper
      return { id: paper.id, title: paper.title, duplicate: imported.duplicate, parseStatus: paper.parseStatus }
    } catch (error) {
      // Do not log the Base64 payload. The stack determines whether the fault
      // is domain-side or happened after the Remote handler was reached.
      this.ctx.logger.error(error)
      throw error
    }
  }

  /** Imports an arXiv record through fixed official endpoints, never a caller supplied download URL. */
  async importArxivPaper(sessionId: string, input: { url: string; libraryId: string | null }) {
    const workspace = this.workspaceOf(sessionId)
    return importArxivPaperIntoWorkspace(this.config, workspace, input)
  }

  /** Resolves candidates for the browser before any public binary download starts. */
  async resolvePaperReference(sessionId: string, reference: string) {
    this.workspaceOf(sessionId)
    return (await resolvePaperReference(reference)).map(candidate => ({
      id: candidate.id, source: candidate.source, canonicalUrl: candidate.canonicalUrl, title: candidate.title,
      authors: [...candidate.authors], year: candidate.year, doi: candidate.doi, pdfUrl: candidate.pdfUrl,
      bibtexAvailable: candidate.bibtex !== null, confidence: candidate.confidence,
      provenance: candidate.provenance.map(item => ({ ...item })),
    }))
  }

  /** Resolves one supported public source and imports its PDF and/or BibTeX into the selected library. */
  async importPaperReference(sessionId: string, input: { reference: string; libraryId: string | null; candidateId?: string }) {
    const candidates = await resolvePaperReference(input.reference)
    const candidate = input.candidateId === undefined ? candidates[0] : candidates.find(item => item.id === input.candidateId)
    if (candidate === undefined) throw new Error('paper reference did not resolve to an importable candidate')
    return importResolvedCandidate(this.config, {
      workspacePath: this.workspaceOf(sessionId), libraryId: input.libraryId, candidate,
    })
  }

  async uploadBibtex(sessionId: string, input: { bibtex: string; libraryId: string | null }) {
    const store = await this.config.store
    const imported = store.createPaperFromBibtex({
      workspacePath: this.workspaceOf(sessionId), bibtex: input.bibtex,
      ...(input.libraryId === null ? {} : { libraryId: input.libraryId }),
    })
    return { id: imported.paper.id, title: imported.paper.title, duplicate: imported.duplicate, parseStatus: imported.paper.parseStatus }
  }

  async replacePaperPdf(
    sessionId: string,
    paperId: string,
    input: { fileName: string; base64: string },
  ) {
    const workspace = this.workspaceOf(sessionId)
    const temporaryPath = await writeBrowserPdf(workspace, input, this.config.maxPdfBytes)
    try {
      const store = await this.config.store
      // A replacement invalidates the active parse revision. Quiesce the old
      // MinerU task before swapping the source PDF so an in-flight parser
      // cannot commit its result after the replacement and make it look like
      // the new upload was parsed.
      await this.config.parseJobs.removePaper(workspace, paperId)
      const paper = await store.replacePaperPdf({
        workspacePath: workspace, paperId, sourcePath: temporaryPath, originalFileName: input.fileName,
      })
      return toPaperDetail(paper, store.getPaperEmbeddingStatus(workspace, paper.id))
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  async startParse(sessionId: string, paperId: string) {
    return this.config.parseJobs.start(this.workspaceOf(sessionId), paperId)
  }

  /** Rebuilds the optional derived BM25/vector index without reparsing the PDF. */
  async reindexPaper(sessionId: string, paperId: string) {
    if (this.config.embedding === undefined) throw new Error('PaperAgent 向量索引服务不可用')
    const job = await this.config.embedding.restart(this.workspaceOf(sessionId), paperId)
    return { status: job.status, totalItems: job.totalItems, completedItems: job.completedItems, error: job.error }
  }

  async getPaperIndexingStatus(sessionId: string, paperId: string) {
    const store = await this.config.store
    return store.getPaperEmbeddingStatus(this.workspaceOf(sessionId), paperId)
  }

  async getParseJob(sessionId: string, jobId: string) {
    return this.config.parseJobs.getDurable(this.workspaceOf(sessionId), jobId)
  }

  async cancelParse(sessionId: string, jobId: string) {
    return this.config.parseJobs.cancel(this.workspaceOf(sessionId), jobId)
  }

  async listPaperFigures(sessionId: string, paperId: string) {
    const store = await this.config.store
    return store.listPaperFigures(this.workspaceOf(sessionId), paperId).map(figure => ({
      id: figure.id, figureLabel: figure.figureLabel, pageNumber: figure.pageNumber, sectionTitle: figure.sectionTitle,
      relativePath: figure.relativePath, rawCaption: figure.rawCaption, visionDescription: figure.visionDescription,
      visionStatus: figure.visionStatus, visionError: figure.visionError, updatedAt: figure.updatedAt,
    }))
  }

  /** Returns one bounded, owned image preview. The browser never receives its filesystem path. */
  async getPaperFigureImage(sessionId: string, figureId: string) {
    const workspace = this.workspaceOf(sessionId)
    const store = await this.config.store
    const figure = store.getPaperFigure(workspace, figureId)
    const paper = store.getPaper(workspace, figure.paperId)
    // Parsed images live beside paper.md in the active immutable revision.
    // Do not resolve them from the paper root: that path only owns original.pdf.
    const source = await readFile(join(paperArtifactPaths(paper).directory, safeFigureRelativePath(figure.relativePath)))
    const previewLimit = 8 * 1024 * 1024
    if (source.byteLength > previewLimit) throw new Error(`figure preview exceeds the ${previewLimit}-byte browser limit`)
    return { mimeType: figure.mimeType, base64: source.toString('base64') }
  }

  async retryPaperFigureDescription(sessionId: string, figureId: string) {
    if (this.config.vision === undefined) throw new Error('PaperAgent visual descriptions are disabled in plugin configuration')
    const workspace = this.workspaceOf(sessionId)
    const store = await this.config.store
    const figure = store.getPaperFigure(workspace, figureId)
    if (figure.visionStatus === 'ready' || figure.visionStatus === 'processing') throw new Error(`figure visual description is already ${figure.visionStatus}`)
    const job = await this.config.vision.start(workspace, figureId)
    return { id: job.id, status: job.status }
  }

  async searchPaperElements(sessionId: string, input: { query: string; types?: string[]; limit?: number; filter?: { libraryId?: string; paperIds?: string[]; section?: string } }) {
    const store = await this.config.store
    return store.searchPaperElements({
      workspacePath: this.workspaceOf(sessionId), query: input.query,
      ...(input.types === undefined ? {} : { types: input.types as readonly PaperElementType[] }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.filter === undefined ? {} : { filter: input.filter }),
    })
  }

  async readPaperElement(sessionId: string, elementId: string) {
    const store = await this.config.store
    return store.readPaperElement({ workspacePath: this.workspaceOf(sessionId), elementId })
  }

  private workspaceOf(sessionId: string): string {
    const agents = this.ctx.agents as { get(id: string): { session: { header: { cwd?: string } } } | undefined }
    const cwd = agents.get(sessionId)?.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') throw new Error('PaperAgent requires a selected workspace session')
    return cwd
  }

  /** Settings are global to the local plugin, but calls still carry one live DSH session for gateway authorization. */
  private assertSessionExists(sessionId: string): void {
    const agents = this.ctx.agents as { get(id: string): unknown | undefined }
    if (agents.get(sessionId) === undefined) throw new Error('PaperAgent requires an active DSH session to update settings')
  }

  private async importBrowserPdf(
    workspace: string,
    input: { fileName: string; base64: string; libraryId: string | null; title?: string },
  ) {
    const temporaryPath = await writeBrowserPdf(workspace, input, this.config.maxPdfBytes)
    try {
      const store = await this.config.store
      return await store.importPaper({
        workspacePath: workspace,
        sourcePath: temporaryPath,
        originalFileName: input.fileName,
        ...(input.libraryId === null ? {} : { libraryId: input.libraryId }),
        ...(input.title === undefined || input.title.trim() === '' ? {} : { title: input.title }),
      })
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }


}

/**
 * Mark methods with the same standard-decorator callback used by DSH packages,
 * without leaving decorator syntax in a bundle that Node executes directly.
 */
function exposeRemote(target: object, method: string): void {
  const initializers: Array<(this: object) => void> = []
  const descriptor = Object.getOwnPropertyDescriptor(target, method)
  if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error(`missing PaperAgent Remote method ${method}`)
  Remote(descriptor.value, {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(initializer) { initializers.push(initializer as (this: object) => void) },
  } as ClassMethodDecoratorContext<object, (this: object, ...args: any[]) => unknown>)
  for (const initialize of initializers) initialize.call(Object.create(target))
}

for (const { method } of paperAgentRemoteContract) {
  exposeRemote(PaperAgentRemoteService.prototype, method)
}
