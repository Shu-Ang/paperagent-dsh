import { canonicalWorkspace } from '@paperagent/domain'
import type { ParseJobRecord, PaperAgentStore } from '@paperagent/domain'
import type { MineruPrecisionParser } from '@paperagent/parser-mineru'

export type ParseJobSnapshot = Omit<ParseJobRecord, 'workspacePath'>

type ManagedParseJob = ParseJobRecord & { readonly controller: AbortController }

/**
 * Observable local MinerU queue backed by SQLite. The in-memory maps only own
 * live AbortControllers; job status and progress remain queryable after DSH
 * restarts and interrupted work is requeued by `recover()`.
 */
export class PaperParseJobs {
  private readonly jobs = new Map<string, ManagedParseJob>()
  private readonly activeByPaper = new Map<string, string>()
  private readonly runningTasks = new Set<Promise<void>>()
  private readonly removedPapers = new Set<string>()
  private stopping = false

  constructor(
    private readonly store: Promise<PaperAgentStore>,
    private readonly parser: MineruPrecisionParser,
    private readonly afterSuccess?: (workspacePath: string, paperId: string, signal: AbortSignal) => Promise<void>,
  ) {}

  async start(workspacePath: string, paperId: string): Promise<ParseJobSnapshot> {
    if (this.stopping) throw new Error('parse worker is stopping')
    const key = this.key(workspacePath, paperId)
    if (this.removedPapers.has(key)) throw new Error('paper is being removed')
    const activeId = this.activeByPaper.get(key)
    if (activeId !== undefined) return this.snapshot(this.requireJob(workspacePath, activeId))
    const store = await this.store
    if (this.removedPapers.has(key)) throw new Error('paper is being removed')
    const durable = store.createParseJob(workspacePath, paperId)
    return this.enqueue(durable)
  }

  get(workspacePath: string, jobId: string): ParseJobSnapshot {
    const live = this.jobs.get(jobId)
    if (live !== undefined && live.workspacePath === canonicalWorkspace(workspacePath)) return this.snapshot(live)
    // A terminal job may have been created by an earlier process.
    throw new Error('parse job is not currently loaded; use getParseJobAsync for durable history')
  }

  async getDurable(workspacePath: string, jobId: string): Promise<ParseJobSnapshot> {
    const store = await this.store
    return this.snapshot(store.getParseJob(workspacePath, jobId))
  }

  async cancel(workspacePath: string, jobId: string): Promise<ParseJobSnapshot> {
    const job = this.requireJob(workspacePath, jobId)
    if (job.status === 'queued' || job.status === 'parsing') {
      job.controller.abort()
      const store = await this.store
      const cancelled = store.updateParseJob(workspacePath, job.id, { status: 'cancelled', error: 'parsing cancelled', finishedAt: new Date().toISOString() })
      Object.assign(job, cancelled)
    }
    return this.snapshot(job)
  }

  /** Re-enqueues every queued/interrupted durable job after plugin boot. */
  async recover(): Promise<void> {
    if (this.stopping) return
    const store = await this.store
    for (const record of store.recoverParseJobs()) this.enqueue(record)
  }

  /** Cancels live parser requests and waits before the store is closed. */
  async stop(): Promise<void> {
    this.stopping = true
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'parsing') job.controller.abort()
    }
    await Promise.allSettled([...this.runningTasks])
  }

  /** Quiesces all work for a paper before its authoritative row is removed. */
  async removePaper(workspacePath: string, paperId: string): Promise<void> {
    const key = this.key(workspacePath, paperId)
    this.removedPapers.add(key)
    try {
      const activeId = this.activeByPaper.get(key)
      if (activeId !== undefined) this.jobs.get(activeId)?.controller.abort()
      await Promise.allSettled([...this.runningTasks])
    } finally {
      this.removedPapers.delete(key)
    }
  }

  private enqueue(record: ParseJobRecord): ParseJobSnapshot {
    if (this.stopping) return this.snapshot(record)
    const key = this.key(record.workspacePath, record.paperId)
    if (this.removedPapers.has(key)) return this.snapshot(record)
    const loaded = this.jobs.get(record.id)
    if (loaded !== undefined) return this.snapshot(loaded)
    const activeId = this.activeByPaper.get(key)
    if (activeId !== undefined) return this.snapshot(this.requireJob(record.workspacePath, activeId))
    const job: ManagedParseJob = { ...record, controller: new AbortController() }
    this.jobs.set(job.id, job)
    this.activeByPaper.set(key, job.id)
    const task = this.run(job).catch(() => undefined)
    this.runningTasks.add(task)
    void task.finally(() => this.runningTasks.delete(task))
    return this.snapshot(job)
  }

  private async run(job: ManagedParseJob): Promise<void> {
    const store = await this.store
    if (this.removedPapers.has(this.key(job.workspacePath, job.paperId))) return
    const startedAt = new Date().toISOString()
    Object.assign(job, store.updateParseJob(job.workspacePath, job.id, { status: 'parsing', startedAt, error: null, finishedAt: null }))
    let parsed = false
    try {
      const artifact = await this.parser.parse(store, job.workspacePath, job.paperId, {
        signal: job.controller.signal,
        onProgress: progress => {
          Object.assign(job, store.updateParseJob(job.workspacePath, job.id, {
            currentPage: progress.currentPage, totalPages: progress.totalPages,
          }))
        },
      })
      Object.assign(job, store.updateParseJob(job.workspacePath, job.id, {
        status: 'ready', chunkCount: artifact.chunkCount, error: null, finishedAt: new Date().toISOString(),
      }))
      parsed = true
      // The parse job must be durable and visible as ready before derived
      // workers are queued. Embedding job creation deliberately rejects a
      // paper whose parse status is still `parsing`.
    } catch (cause) {
      // cancel() has already persisted the terminal user intent; do not turn it
      // back into a generic parser failure when the abort propagates here.
      if (!job.controller.signal.aborted) {
        const error = cause instanceof Error ? cause.message : String(cause)
        Object.assign(job, store.updateParseJob(job.workspacePath, job.id, { status: 'failed', error, finishedAt: new Date().toISOString() }))
      }
    } finally {
      // Derived work is part of the parser task's lifecycle. Waiting here
      // prevents plugin teardown from closing SQLite while vision/indexing
      // callbacks are still reading it, and keeps the paper marked active
      // until the post-parse handoff has completed. A derived-worker failure
      // must not rewrite an already successful parse job; those workers own
      // their durable error state.
      if (parsed && this.afterSuccess !== undefined) {
        await this.afterSuccess(job.workspacePath, job.paperId, job.controller.signal).catch(() => undefined)
      }
      this.activeByPaper.delete(this.key(job.workspacePath, job.paperId))
    }
  }

  private requireJob(workspacePath: string, jobId: string): ManagedParseJob {
    const job = this.jobs.get(jobId)
    if (job === undefined || job.workspacePath !== canonicalWorkspace(workspacePath)) throw new Error('parse job not found in the active workspace')
    return job
  }

  private key(workspacePath: string, paperId: string): string { return `${canonicalWorkspace(workspacePath)}\u0000${paperId}` }

  private snapshot(job: ParseJobRecord): ParseJobSnapshot {
    // Live jobs carry an AbortController for cancellation. It is intentionally
    // host-only and must never cross the Typert JSON boundary.
    const { workspacePath: _workspacePath, controller: _controller, ...snapshot } = job as ManagedParseJob
    return snapshot
  }
}
