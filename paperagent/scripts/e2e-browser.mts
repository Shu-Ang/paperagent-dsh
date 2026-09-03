/**
 * Browser-level acceptance test for a running local DSH + PaperAgent host.
 *
 * Start DSH with exactly one PaperAgent bundle, then run:
 *   PAPERAGENT_E2E_ORIGIN=http://127.0.0.1:3091 pnpm e2e:browser
 */
import { chromium } from 'playwright'

const origin = process.env.PAPERAGENT_E2E_ORIGIN ?? 'http://127.0.0.1:3091'
const samplePdf = process.env.PAPERAGENT_E2E_PDF
const waitForParse = process.env.PAPERAGENT_E2E_WAIT_FOR_PARSE === '1'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

try {
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  if (response === null || !response.ok()) throw new Error(`DSH did not load from ${origin}`)

  // These are the user-visible acceptance conditions, deliberately avoiding
  // implementation-only class names or remote method details.
  const libraryEntry = page.getByRole('button', { name: /论文库/i })
  await libraryEntry.waitFor({ state: 'visible', timeout: 20_000 })
  await libraryEntry.click()
  await page.getByRole('button', { name: /新建论文/i }).waitFor({ state: 'visible', timeout: 10_000 })

  const reportEntry = page.getByRole('button', { name: /报告库|笔记库/i })
  if (await reportEntry.count() > 0) throw new Error('obsolete report/note library entry is still rendered')
  if (samplePdf !== undefined) {
    await page.getByRole('button', { name: /新建论文/i }).click()
    await page.locator('input[type="file"]').first().setInputFiles(samplePdf)
    await page.getByRole('button', { name: /创建论文/i }).click()
    // This validates the actual Remote upload -> async MinerU job boundary;
    // successful parsing can take minutes and is intentionally not browser-blocking.
    await page.getByText(/等待解析|解析中|完成|失败/).first().waitFor({ state: 'visible', timeout: 30_000 })
    process.stdout.write('PASS browser E2E: PDF upload queued for MinerU\n')
    if (waitForParse) {
      await page.getByText('完成').first().waitFor({ state: 'visible', timeout: 10 * 60_000 })
      process.stdout.write('PASS browser E2E: MinerU parse reached ready state\n')
    }
  }
  process.stdout.write(`PASS browser E2E: PaperAgent library navigation at ${origin}\n`)
} finally {
  await browser.close()
}
