import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalWorkspace, paperArtifactPaths, safeFigureRelativePath } from '@paperagent/domain'
import type { PaperAgentStore, PaperEmbeddingSource, PaperRecord } from '@paperagent/domain'
import type { DashScopeEmbeddingClient } from '@paperagent/embedding-dashscope'
import type { ElasticsearchVectorIndex } from '@paperagent/retriever-elasticsearch'

/** Durable derived-index worker. It can build ES BM25-only documents or add vectors. */
export class PaperEmbeddingJobs {
  private readonly active = new Set<string>()
  private readonly pending: string[] = []
  private readonly pendingJobs = new Map<string, { readonly workspacePath: string; readonly jobId: string }>()
  private readonly runningTasks = new Set<Promise<void>>()
  private readonly removedPapers = new Set<string>()
  private running = 0
  private stopping = false
  constructor(
    private readonly storePromise: Promise<PaperAgentStore>,
    private readonly options: { readonly provider: string; readonly model: string; readonly dimensions: number; readonly concurrency: number; readonly indexPrefix: string; readonly maxImageBytes: number },
    private readonly clients: () => Promise<{ readonly embedder?: DashScopeEmbeddingClient; readonly index: ElasticsearchVectorIndex }>,
  ) {}

  async start(workspacePath: string, paperId: string): Promise<void> {
    if (this.stopping) throw new Error('embedding worker is stopping')
    const store = await this.storePromise
    const paper = store.getPaper(workspacePath, paperId)
    if (this.removedPapers.has(this.paperKey(paper.workspacePath, paper.id))) throw new Error('paper is being removed')
    const settings = store.getVectorSettings(); if (!settings.elasticsearchEnabled) return
    const job = store.createEmbeddingJob(workspacePath, paperId, this.options)
    this.enqueue(job.workspacePath, job.id)
  }

  /** Explicit user action to re-index the current, already parsed revision. */
  async restart(workspacePath: string, paperId: string) {
    if (this.stopping) throw new Error('embedding worker is stopping')
    const store = await this.storePromise
    const paper = store.getPaper(workspacePath, paperId)
    if (this.removedPapers.has(this.paperKey(paper.workspacePath, paper.id))) throw new Error('paper is being removed')
    const settings = store.getVectorSettings()
    if (!settings.elasticsearchEnabled) {
      throw new Error('请先在 PaperAgent 设置中启用 Embedding 和 Elasticsearch 索引')
    }
    const job = store.restartEmbeddingJob(workspacePath, paperId, this.options)
    this.enqueue(job.workspacePath, job.id)
    return job
  }

  async recover(): Promise<void> {
    if (this.stopping) return
    const store = await this.storePromise
    for (const job of store.recoverEmbeddingJobs()) this.enqueue(job.workspacePath, job.id)
  }

  /**
   * Quiesces one paper, lets the caller remove its authoritative row, then
   * cleans the rebuildable Elasticsearch projections. Keeping the removal
   * marker until both steps finish closes the delete/reindex race.
   */
  async remove(workspacePath: string, paperId: string, removeAuthoritative: () => Promise<void>): Promise<void> {
    if (this.stopping) return
    const paperKey = this.paperKey(workspacePath, paperId)
    this.removedPapers.add(paperKey)
    try {
      // Prevent a queued job for the just-deleted row from starting after the
      // vector cleanup. Running jobs are drained first; their next write
      // boundary checks `removedPapers` before touching Elasticsearch.
      const store = await this.storePromise
      for (const [pendingKey, pending] of this.pendingJobs) {
        try {
          const job = store.getEmbeddingJob(pending.workspacePath, pending.jobId)
          if (this.paperKey(job.workspacePath, job.paperId) === paperKey) {
            this.pendingJobs.delete(pendingKey)
            this.active.delete(pendingKey)
          }
        } catch {
          this.pendingJobs.delete(pendingKey)
          this.active.delete(pendingKey)
        }
      }
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        if (!this.pendingJobs.has(this.pending[index]!)) this.pending.splice(index, 1)
      }
      await Promise.allSettled([...this.runningTasks])
      await removeAuthoritative()
      const { index } = await this.clients()
      const workspaceKey = hash(canonicalWorkspace(workspacePath))
      const chunksIndex = `${this.options.indexPrefix}-chunks-v1`
      const elementsIndex = `${this.options.indexPrefix}-elements-v1`
      await Promise.all([
        index.deletePaperSources(chunksIndex, workspaceKey, paperId),
        index.deletePaperSources(elementsIndex, workspaceKey, paperId),
      ])
    } finally {
      this.removedPapers.delete(paperKey)
    }
  }

  /** Updates the lightweight library filter field on existing projections. */
  async updatePaperLibrary(workspacePath: string, paperId: string, libraryId: string | null): Promise<void> {
    await this.updatePapersLibrary(workspacePath, [paperId], libraryId)
  }

  /** Batch updates the lightweight library filter field on existing projections. */
  async updatePapersLibrary(workspacePath: string, paperIds: readonly string[], libraryId: string | null): Promise<void> {
    if (this.stopping) return
    const { index } = await this.clients()
    const workspaceKey = hash(canonicalWorkspace(workspacePath))
    await Promise.all([
      index.updatePapersLibrary(`${this.options.indexPrefix}-chunks-v1`, workspaceKey, paperIds, libraryId),
      index.updatePapersLibrary(`${this.options.indexPrefix}-elements-v1`, workspaceKey, paperIds, libraryId),
    ])
  }

  /** Stops accepting work and waits for active embedding requests to settle. */
  async stop(): Promise<void> {
    this.stopping = true
    this.pending.length = 0
    this.pendingJobs.clear()
    await Promise.allSettled([...this.runningTasks])
  }

  private enqueue(workspacePath: string, jobId: string): void {
    if (this.stopping) return
    const key = `${workspacePath}\u0000${jobId}`
    if (this.active.has(key)) return
    this.active.add(key)
    this.pendingJobs.set(key, { workspacePath, jobId })
    this.pending.push(key)
    void this.drain()
  }

  private async drain(): Promise<void> {
    while (!this.stopping && this.running < this.options.concurrency) {
      const key = this.pending.shift()
      if (key === undefined) return
      const pending = this.pendingJobs.get(key)
      if (pending === undefined) continue
      this.pendingJobs.delete(key)
      this.running += 1
      const task = Promise.resolve().then(() => this.run(pending.workspacePath, pending.jobId))
      this.runningTasks.add(task)
      void task.then(() => undefined, () => undefined).finally(() => {
        this.runningTasks.delete(task)
        this.active.delete(key)
        this.running -= 1
        void this.drain()
      })
    }
  }

  private async run(workspacePath: string, jobId: string): Promise<void> {
    const store = await this.storePromise
    let job = store.getEmbeddingJob(workspacePath, jobId)
    const paperKey = this.paperKey(job.workspacePath, job.paperId)
    if (this.removedPapers.has(paperKey)) return
    job = store.updateEmbeddingJob(workspacePath, jobId, { status: 'processing', error: null, startedAt: new Date().toISOString(), finishedAt: null })
    try {
      const paper = this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
      const clients = await this.clients()
      const index = clients.index
      // The persisted switch is authoritative at execution time. This lets
      // users turn vectors off while keeping the ES BM25 projection usable.
      const embedder = store.getVectorSettings().embeddingEnabled ? clients.embedder : undefined
      const chunksIndex = `${this.options.indexPrefix}-chunks-v1`, elementsIndex = `${this.options.indexPrefix}-elements-v1`
      await Promise.all([index.ensureIndex(chunksIndex, embedder === undefined ? undefined : this.options.dimensions), index.ensureIndex(elementsIndex, embedder === undefined ? undefined : this.options.dimensions)])
      const currentWorkspaceKey = hash(canonicalWorkspace(paper.workspacePath))
      let completed = 0
      const documents: Array<Parameters<ElasticsearchVectorIndex['upsert']>[1][number]> = []
      for (const source of store.listEmbeddingSources(workspacePath, paper.id)) {
        this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
        const image = embedder === undefined ? undefined : await this.imageFor(paper, source)
        const embedding = embedder === undefined ? undefined : await embedder.embed({ text: source.text, ...(image === undefined ? {} : { image }) })
        this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
        documents.push({
          id: identity(source), workspaceKey: currentWorkspaceKey, libraryId: source.libraryId, paperId: source.paperId, sourceId: source.sourceId,
          sourceKind: source.kind, title: source.title, section: source.section, pdfPageStart: source.pdfPageStart, pdfPageEnd: source.pdfPageEnd,
          ...(source.elementType === undefined ? {} : { elementType: source.elementType }), ...(source.caption === undefined ? {} : { caption: source.caption }), contentRevision: source.parseRevision,
          ...(embedding === undefined ? {} : { embeddingProvider: this.options.provider, embeddingModel: this.options.model, embedding }), content: source.text,
        })
        completed += 1
        this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
        store.updateEmbeddingJob(workspacePath, jobId, { completedItems: completed })
      }
      const chunks = documents.filter(document => document.sourceKind === 'chunk')
      const elements = documents.filter(document => document.sourceKind === 'element')
      for (const batch of batches(chunks, 32)) {
        this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
        await index.upsert(chunksIndex, batch)
      }
      for (const batch of batches(elements, 32)) {
        this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
        await index.upsert(elementsIndex, batch)
      }
      this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
      // Remove old revisions only after the new projection has been fully
      // written. A failed rebuild therefore leaves the previous searchable
      // projection available instead of deleting it first.
      await Promise.all([
        index.deletePaperSourcesExceptRevision(chunksIndex, currentWorkspaceKey, paper.id, job.parseRevision),
        index.deletePaperSourcesExceptRevision(elementsIndex, currentWorkspaceKey, paper.id, job.parseRevision),
      ])
      this.currentPaper(store, workspacePath, job.paperId, job.parseRevision, paperKey)
      store.updateEmbeddingJob(workspacePath, jobId, { status: 'ready', completedItems: completed, finishedAt: new Date().toISOString() })
    } catch (error) {
      if (this.removedPapers.has(paperKey)) return
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof SupersededEmbeddingError) {
        store.updateEmbeddingJob(workspacePath, jobId, { status: 'cancelled', error: message.slice(0, 1000), finishedAt: new Date().toISOString() })
      } else {
        store.updateEmbeddingJob(workspacePath, jobId, { status: 'failed', error: message.slice(0, 1000), retryCount: job.retryCount + 1, finishedAt: new Date().toISOString() })
      }
    }
  }

  private currentPaper(store: PaperAgentStore, workspacePath: string, paperId: string, revision: string, paperKey: string): PaperRecord {
    if (this.removedPapers.has(paperKey)) throw new SupersededEmbeddingError('embedding cancelled because the paper is being removed')
    const paper = store.getPaper(workspacePath, paperId)
    if (paper.parseStatus !== 'ready' || paper.parseRevision !== revision) {
      throw new SupersededEmbeddingError('embedding cancelled because the paper parse revision changed')
    }
    return paper
  }

  private async imageFor(paper: PaperRecord, source: PaperEmbeddingSource) {
    if (source.image === undefined) return undefined
    const bytes = await readFile(join(paperArtifactPaths(paper).directory, safeFigureRelativePath(source.image.relativePath)))
    return bytes.byteLength > this.options.maxImageBytes ? undefined : { bytes, mimeType: source.image.mimeType }
  }

  private paperKey(workspacePath: string, paperId: string): string {
    return `${canonicalWorkspace(workspacePath)}\u0000${paperId}`
  }
}

class SupersededEmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupersededEmbeddingError'
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function identity(source: PaperEmbeddingSource): string { return hash(`${canonicalWorkspace(source.workspacePath)}\u0000${source.paperId}\u0000${source.sourceId}`) }

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size))
  return result
}
