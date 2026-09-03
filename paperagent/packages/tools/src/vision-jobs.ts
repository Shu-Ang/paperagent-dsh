import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalWorkspace, paperArtifactPaths, safeFigureRelativePath } from '@paperagent/domain'
import type { PaperAgentStore, VisionJobRecord } from '@paperagent/domain'
import type { DeepSeekVisionClient } from '@paperagent/vision-deepseek'
import { VISION_PROMPT_VERSION } from '@paperagent/vision-deepseek'

export type FigureVisionJob = VisionJobRecord

/**
 * A bounded visual-description queue. SQLite owns job lifecycle; the maps only
 * contain live work, so queued/processing jobs can safely be recovered after a
 * DSH restart.
 */
export class PaperVisionJobs {
  private readonly jobs = new Map<string, FigureVisionJob>()
  private running = 0
  private readonly pending: string[] = []
  private readonly runningTasks = new Set<Promise<void>>()
  private readonly removedPapers = new Set<string>()
  private stopping = false

  constructor(
    private readonly store: Promise<PaperAgentStore>,
    private readonly client: DeepSeekVisionClient,
    private readonly model: string,
    private readonly concurrency: number,
    private readonly timeoutMs: number,
    private readonly maxImageBytes: number,
    private readonly maxRetries: number,
  ) {}

  async start(workspacePath: string, figureId: string): Promise<FigureVisionJob> {
    if (this.stopping) throw new Error('visual description worker is stopping')
    const store = await this.store
    const figure = store.getPaperFigure(workspacePath, figureId)
    if (this.removedPapers.has(this.paperKey(figure.workspacePath, figure.paperId))) throw new Error('paper is being removed')
    return this.enqueue(store.createVisionJob(workspacePath, figureId))
  }

  async startQueuedForPaper(workspacePath: string, paperId: string): Promise<FigureVisionJob[]> {
    const store = await this.store
    const figures = store.listPaperFigures(workspacePath, paperId)
    return Promise.all(figures
      .filter(figure => figure.visionStatus === 'queued' || figure.visionStatus === 'failed')
      .map(figure => this.start(workspacePath, figure.id)))
  }

  async get(workspacePath: string, jobId: string): Promise<FigureVisionJob> {
    const live = this.jobs.get(jobId)
    if (live !== undefined && live.workspacePath === workspacePath) return live
    return (await this.store).getVisionJob(workspacePath, jobId)
  }

  async recover(): Promise<void> {
    if (this.stopping) return
    const store = await this.store
    for (const record of store.recoverVisionJobs()) this.enqueue(record)
  }

  /** Waits until all visual jobs currently belonging to a paper are terminal. */
  async waitForPaper(workspacePath: string, paperId: string, signal?: AbortSignal): Promise<void> {
    while (!this.stopping && signal?.aborted !== true) {
      const active = (await this.store).listPaperFigures(workspacePath, paperId)
        .some(figure => figure.visionStatus === 'queued' || figure.visionStatus === 'processing')
      if (!active) return
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
  }

  /** Stops accepting work and waits for currently running requests. */
  async stop(): Promise<void> {
    this.stopping = true
    this.pending.length = 0
    await Promise.allSettled([...this.runningTasks])
  }

  /** Quiesces visual work before the owning paper and figures are removed. */
  async removePaper(workspacePath: string, paperId: string): Promise<void> {
    const paperKey = this.paperKey(workspacePath, paperId)
    this.removedPapers.add(paperKey)
    try {
      const store = await this.store
      const removedJobIds = new Set<string>()
      for (const [jobId, job] of this.jobs) {
        try {
          if (this.paperKey(job.workspacePath, store.getPaperFigure(job.workspacePath, job.figureId).paperId) === paperKey) removedJobIds.add(jobId)
        } catch { /* a stale durable job is already detached from its figure */ }
      }
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        const jobId = this.pending[index]
        if (jobId !== undefined && removedJobIds.has(jobId)) this.pending.splice(index, 1)
      }
      await Promise.allSettled([...this.runningTasks])
      for (const jobId of removedJobIds) this.jobs.delete(jobId)
    } finally {
      this.removedPapers.delete(paperKey)
    }
  }

  private enqueue(record: FigureVisionJob): FigureVisionJob {
    if (this.stopping) return record
    if (this.jobs.has(record.id)) return this.jobs.get(record.id)!
    if ([...this.jobs.values()].some(job => job.workspacePath === record.workspacePath && job.figureId === record.figureId && (job.status === 'queued' || job.status === 'processing'))) {
      return record
    }
    this.jobs.set(record.id, record)
    this.pending.push(record.id)
    void this.drain()
    return record
  }

  private async drain(): Promise<void> {
    while (!this.stopping && this.running < this.concurrency) {
      const jobId = this.pending.shift()
      if (jobId === undefined) return
      const job = this.jobs.get(jobId)
      if (job === undefined || job.status !== 'queued') continue
      this.running += 1
      const task = this.run(job)
      this.runningTasks.add(task)
      void task.then(() => undefined, () => undefined).finally(() => {
        this.runningTasks.delete(task)
        this.running -= 1
        if (!this.stopping) void this.drain()
      })
    }
  }

  private async run(job: FigureVisionJob): Promise<void> {
    const store = await this.store
    let paperKey: string | undefined
    try {
      paperKey = this.paperKey(job.workspacePath, store.getPaperFigure(job.workspacePath, job.figureId).paperId)
    } catch {
      return
    }
    if (this.removedPapers.has(paperKey)) return
    const processing = store.updateVisionJob(job.workspacePath, job.id, { status: 'processing', error: null, startedAt: new Date().toISOString(), finishedAt: null })
    this.jobs.set(job.id, processing)
    try {
      const figure = store.setPaperFigureVisionStatus(job.workspacePath, job.figureId, 'processing')
      if (this.removedPapers.has(paperKey)) return
      const reusable = store.findReusableFigureVision(job.workspacePath, figure.sha256, figure.id)
      if (reusable !== undefined && reusable.visionDescription !== null) {
        store.setPaperFigureVisionStatus(job.workspacePath, job.figureId, 'ready', {
          description: reusable.visionDescription, model: reusable.visionModel ?? this.model,
          promptVersion: reusable.visionPromptVersion ?? VISION_PROMPT_VERSION,
        })
        this.jobs.set(job.id, store.updateVisionJob(job.workspacePath, job.id, { status: 'ready', finishedAt: new Date().toISOString() }))
        return
      }
      const paper = store.getPaper(job.workspacePath, figure.paperId)
      const image = await readFile(join(paperArtifactPaths(paper).directory, safeFigureRelativePath(figure.relativePath)))
      if (image.byteLength > this.maxImageBytes) throw new Error(`figure image exceeds the ${this.maxImageBytes}-byte vision limit`)
      if (!isSupportedImageMime(figure.mimeType)) throw new Error(`unsupported figure MIME type: ${figure.mimeType}`)
      const description = await this.describeWithRetries({
        image, mimeType: figure.mimeType, rawCaption: figure.rawCaption, sectionTitle: figure.sectionTitle, nearbyText: figure.nearbyText,
      })
      if (this.removedPapers.has(paperKey)) return
      const text = [description.summary, description.axesAndLegend, ...description.keyFindings, ...description.ocrText, ...description.uncertainties].filter(Boolean).join('\n')
      store.setPaperFigureVisionStatus(job.workspacePath, job.figureId, 'ready', { description: text, model: this.model, promptVersion: VISION_PROMPT_VERSION })
      this.jobs.set(job.id, store.updateVisionJob(job.workspacePath, job.id, { status: 'ready', finishedAt: new Date().toISOString() }))
    } catch (error) {
      if (paperKey !== undefined && this.removedPapers.has(paperKey)) return
      const message = safeError(error)
      try { store.setPaperFigureVisionStatus(job.workspacePath, job.figureId, 'failed', { error: message, model: this.model, promptVersion: VISION_PROMPT_VERSION }) } catch { /* preserve original task error */ }
      this.jobs.set(job.id, store.updateVisionJob(job.workspacePath, job.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() }))
    }
  }

  private paperKey(workspacePath: string, paperId: string): string {
    return `${canonicalWorkspace(workspacePath)}\u0000${paperId}`
  }

  private async describeWithRetries(input: Parameters<DeepSeekVisionClient['describe']>[0]) {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try { return await this.client.describe({ ...input, signal: AbortSignal.timeout(this.timeoutMs) }) } catch (error) {
        lastError = error
        if (attempt === this.maxRetries || !isRetryable(error)) throw error
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(2_000, 250 * (2 ** attempt))))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

function isSupportedImageMime(value: string): value is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return !/API key is missing|HTTP 4(00|01|03|04|13|22)|invalid JSON|non-object description|missing figureType/i.test(message)
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]').slice(0, 1_000)
}
