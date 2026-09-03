import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PaperAgentStore } from '../packages/domain/src/index.ts'
import type { MineruPrecisionParser } from '../packages/parser-mineru/src/index.ts'
import { PaperParseJobs } from '../packages/tools/src/parse-jobs.ts'

async function fixture(): Promise<{ root: string; workspace: string; store: PaperAgentStore; jobs: PaperParseJobs }> {
  const root = await mkdtemp(join(tmpdir(), 'paperagent-jobs-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = await PaperAgentStore.open({ databasePath: join(root, 'domain.sqlite'), maxPdfBytes: 1024 * 1024 })
  return { root, workspace, store, jobs: new PaperParseJobs(Promise.resolve(store), testParser()) }
}

test('parse jobs expose MinerU progress and durable completion state', async () => {
  const { root, workspace, store, jobs } = await fixture()
  try {
    const source = join(root, 'article.pdf')
    await writeFile(source, '%PDF-1.4\nunit test\n')
    const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: source })).paper
    const started = await jobs.start(workspace, paper.id)
    assert.equal(started.status, 'queued')

    const finished = await waitForTerminal(jobs, workspace, started.id)
    assert.equal(finished.status, 'ready')
    assert.equal(finished.currentPage, 2)
    assert.equal(finished.totalPages, 2)
    assert.equal(finished.chunkCount, 1)
    assert.equal(store.getPaper(workspace, paper.id).parseStatus, 'ready')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling a queued MinerU job preserves its PDF and records a retryable parse failure', async () => {
  const { root, workspace, store, jobs } = await fixture()
  try {
    const source = join(root, 'article.pdf')
    await writeFile(source, '%PDF-1.4\nunit test\n')
    const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: source })).paper
    const started = await jobs.start(workspace, paper.id)
    await jobs.cancel(workspace, started.id)

    const finished = await waitForTerminal(jobs, workspace, started.id)
    assert.equal(finished.status, 'cancelled')
    const durable = store.getPaper(workspace, paper.id)
    assert.equal(durable.parseStatus, 'failed')
    assert.match(durable.parseError ?? '', /cancelled/)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('visual queue scheduling failures do not change an already successful PDF parse', async () => {
  const { root, workspace, store } = await fixture()
  const jobs = new PaperParseJobs(Promise.resolve(store), testParser(), async () => { throw new Error('visual queue unavailable') })
  try {
    const source = join(root, 'article.pdf')
    await writeFile(source, '%PDF-1.4\nunit test\n')
    const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: source })).paper
    const started = await jobs.start(workspace, paper.id)
    const finished = await waitForTerminal(jobs, workspace, started.id)
    assert.equal(finished.status, 'ready')
    assert.equal(store.getPaper(workspace, paper.id).parseStatus, 'ready')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a new queue instance recovers an interrupted durable parse job after restart', async () => {
  const { root, workspace, store } = await fixture()
  try {
    const source = join(root, 'article.pdf')
    await writeFile(source, '%PDF-1.4\nunit test\n')
    const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: source })).paper
    const durable = store.createParseJob(workspace, paper.id)
    store.updateParseJob(workspace, durable.id, { status: 'parsing', startedAt: new Date().toISOString() })
    store.setParseStatus(workspace, paper.id, 'parsing', { parserVersion: 'mineru-test' })

    const recovered = new PaperParseJobs(Promise.resolve(store), testParser())
    await recovered.recover()
    const done = await waitForTerminal(recovered, workspace, durable.id)
    assert.equal(done.status, 'ready')
    assert.equal(store.getParseJob(workspace, durable.id).status, 'ready')
    assert.equal(store.getPaper(workspace, paper.id).parseStatus, 'ready')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

function testParser(): MineruPrecisionParser {
  return {
    async parse(
      store: PaperAgentStore,
      workspacePath: string,
      paperId: string,
      options: { signal?: AbortSignal; onProgress?: (progress: { currentPage: number; totalPages: number }) => void },
    ) {
      store.setParseStatus(workspacePath, paperId, 'parsing', { parserVersion: 'mineru-test' })
      if (options.signal?.aborted === true) {
        store.setParseStatus(workspacePath, paperId, 'failed', { error: 'parsing cancelled', parserVersion: 'mineru-test' })
        throw new Error('parsing cancelled')
      }
      options.onProgress?.({ currentPage: 2, totalPages: 2 })
      store.replacePaperChunks(workspacePath, paperId, [{
        id: 'chunk-1', paperId, workspacePath, section: 'Introduction', pdfPageStart: 2, pdfPageEnd: 2,
        lineStart: 1, lineEnd: 1, content: 'MinerU result', createdAt: new Date().toISOString(),
      }])
      const ready = store.setParseStatus(workspacePath, paperId, 'ready', { parserVersion: 'mineru-test' })
      return { paper: ready, markdownPath: 'paper.md', sourceMapPath: 'source-map.json', chunkCount: 1, elementCount: 0 }
    },
  } as unknown as MineruPrecisionParser
}

async function waitForTerminal(jobs: PaperParseJobs, workspace: string, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = jobs.get(workspace, jobId)
    if (current.status === 'ready' || current.status === 'failed' || current.status === 'cancelled') return current
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error('parse job did not finish within 2 seconds')
}
