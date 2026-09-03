import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PaperAgentStore, PaperFigureRecord, PaperRecord } from '../packages/domain/src/index.ts'
import type { DeepSeekVisionClient } from '../packages/vision-deepseek/src/index.ts'
import { PaperVisionJobs } from '../packages/tools/src/vision-jobs.ts'

test('vision jobs deduplicate identical image bytes without a second model request', async () => {
  const fixture = await visionFixture()
  try {
    const reusable = { ...fixture.figure, id: 'existing', visionStatus: 'ready' as const, visionDescription: 'Reusable description.', visionModel: 'vision', visionPromptVersion: 'test' }
    let calls = 0
    const jobs = new PaperVisionJobs(Promise.resolve(fixture.store({ reusable })), {
      describe: async () => { calls += 1; throw new Error('should not be called') },
    } as unknown as DeepSeekVisionClient, 'vision', 1, 1_000, 1024, 0)
    const job = await jobs.start(fixture.workspace, fixture.figure.id)
    const done = await terminal(jobs, fixture.workspace, job.id)
    assert.equal(done.status, 'ready')
    assert.equal(calls, 0)
    assert.equal(fixture.figure.visionDescription, 'Reusable description.')
  } finally { await fixture.dispose() }
})

test('vision jobs retry a transient failure and keep the parent paper outside the failure path', async () => {
  const fixture = await visionFixture()
  try {
    let calls = 0
    const jobs = new PaperVisionJobs(Promise.resolve(fixture.store()), {
      describe: async () => {
        calls += 1
        if (calls === 1) throw new Error('network unavailable')
        return { figureType: 'plot', summary: 'A plotted comparison.', ocrText: [], axesAndLegend: 'x axis', keyFindings: ['improves'], uncertainties: [] }
      },
    } as unknown as DeepSeekVisionClient, 'vision', 1, 1_000, 1024, 1)
    const job = await jobs.start(fixture.workspace, fixture.figure.id)
    const done = await terminal(jobs, fixture.workspace, job.id)
    assert.equal(done.status, 'ready')
    assert.equal(calls, 2)
    assert.equal(fixture.figure.visionStatus, 'ready')
    assert.match(fixture.figure.visionDescription ?? '', /plotted comparison/)
  } finally { await fixture.dispose() }
})

test('a new visual queue instance re-enqueues a durable interrupted job after restart', async () => {
  const fixture = await visionFixture()
  try {
    const store = fixture.store()
    const durable = store.createVisionJob(fixture.workspace, fixture.figure.id)
    store.updateVisionJob(fixture.workspace, durable.id, { status: 'processing', startedAt: new Date().toISOString() })
    const jobs = new PaperVisionJobs(Promise.resolve(store), {
      describe: async () => ({ figureType: 'plot', summary: 'Recovered.', ocrText: [], axesAndLegend: '', keyFindings: [], uncertainties: [] }),
    } as unknown as DeepSeekVisionClient, 'vision', 1, 1_000, 1024, 0)
    await jobs.recover()
    const done = await terminal(jobs, fixture.workspace, durable.id)
    assert.equal(done.status, 'ready')
  } finally { await fixture.dispose() }
})

async function visionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'paperagent-vision-'))
  const workspace = join(root, 'workspace')
  const directory = join(workspace, '.paperagent', 'papers', 'paper-1')
  await mkdir(join(directory, 'images'), { recursive: true })
  await writeFile(join(directory, 'images', 'figure-001.png'), Buffer.from([137, 80, 78, 71]))
  const paper = { id: 'paper-1', workspacePath: workspace, relativeDir: 'papers/paper-1' } as PaperRecord
  const figure: PaperFigureRecord = {
    id: 'figure-1', paperId: paper.id, workspacePath: workspace, elementId: null, figureLabel: 'Figure 1', pageNumber: 1, sectionTitle: 'Results',
    relativePath: 'images/figure-001.png', mimeType: 'image/png', sha256: 'same-bytes', rawCaption: 'Comparison', nearbyText: 'Results context.',
    visionDescription: null, visionStatus: 'queued', visionModel: null, visionPromptVersion: null, visionError: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const store = ({ reusable }: { reusable?: PaperFigureRecord } = {}) => {
    const jobs = new Map<string, { id: string; workspacePath: string; figureId: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }>()
    return {
    createVisionJob: (workspacePath: string, figureId: string) => {
      const active = [...jobs.values()].find(job => job.workspacePath === workspacePath && job.figureId === figureId && (job.status === 'queued' || job.status === 'processing'))
      if (active !== undefined) return active
      const job = { id: `job-${jobs.size + 1}`, workspacePath, figureId, status: 'queued' as const, error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }
      jobs.set(job.id, job)
      return job
    },
    getVisionJob: (_workspacePath: string, id: string) => jobs.get(id)!,
    updateVisionJob: (_workspacePath: string, id: string, patch: Record<string, unknown>) => {
      const current = jobs.get(id)!
      Object.assign(current, patch)
      return current
    },
    recoverVisionJobs: () => {
      for (const job of jobs.values()) if (job.status === 'queued' || job.status === 'processing') Object.assign(job, { status: 'queued', error: null, startedAt: null, finishedAt: null })
      return [...jobs.values()]
    },
    setPaperFigureVisionStatus: (_workspace: string, _id: string, status: PaperFigureRecord['visionStatus'], details: { description?: string; model?: string; promptVersion?: string; error?: string } = {}) => {
      Object.assign(figure, { visionStatus: status, visionDescription: status === 'ready' ? details.description ?? figure.visionDescription : figure.visionDescription, visionError: status === 'failed' ? details.error ?? 'failed' : null, visionModel: details.model ?? figure.visionModel, visionPromptVersion: details.promptVersion ?? figure.visionPromptVersion })
      return figure
    },
    findReusableFigureVision: () => reusable,
    getPaper: () => paper,
    listPaperFigures: () => [figure],
  } as unknown as PaperAgentStore
  }
  return { workspace, figure, store, dispose: () => rm(root, { recursive: true, force: true }) }
}

async function terminal(jobs: PaperVisionJobs, workspace: string, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await jobs.get(workspace, jobId)
    if (current.status !== 'queued' && current.status !== 'processing') return current
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error('vision job did not finish within two seconds')
}
