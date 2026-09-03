/** Opt-in live MinerU acceptance test. It never reads DSH credential files. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PaperAgentStore } from '@paperagent/domain'
import { MineruPrecisionParser } from '@paperagent/parser-mineru'

const token = process.env.MINERU_API_TOKEN
const samplePdf = process.env.PAPERAGENT_MINERU_TEST_PDF
if (token === undefined || samplePdf === undefined) {
  throw new Error('Set MINERU_API_TOKEN and PAPERAGENT_MINERU_TEST_PDF to run the live MinerU acceptance test.')
}

const root = await mkdtemp(join(tmpdir(), 'paperagent-mineru-live-'))
const workspace = join(root, 'workspace')
const store = await PaperAgentStore.open({ databasePath: join(root, 'paperagent.sqlite'), maxPdfBytes: 200 * 1024 * 1024 })
try {
  const paper = (await store.importPaper({ workspacePath: workspace, sourcePath: resolve(samplePdf) })).paper
  const parser = new MineruPrecisionParser({
    config: { apiBaseUrl: 'https://mineru.net', apiToken: token, modelVersion: 'vlm', enableOcr: false, enableFormula: true, enableTable: true, pollIntervalMs: 3_000, timeoutMs: 10 * 60_000 },
  })
  const result = await parser.parse(store, workspace, paper.id)
  if (result.chunkCount < 1 || store.getPaper(workspace, paper.id).parseStatus !== 'ready') throw new Error('MinerU returned no committed PaperAgent parse result')
  process.stdout.write(`PASS MinerU live integration: ${result.chunkCount} chunks, ${result.elementCount} elements\n`)
} finally {
  store.close()
  await rm(root, { recursive: true, force: true })
}
