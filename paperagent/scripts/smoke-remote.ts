/**
 * Verifies that every PaperAgent Remote endpoint exists in a running DSH Host.
 *
 * It intentionally uses an unknown session id: a business rejection is the
 * expected result, while a 404 means the Host loaded an old/missing plugin
 * bundle. Run after `pnpm run build` and restarting `dsh web`.
 */
import { paperAgentRemoteContract } from '../packages/contracts/src/index.ts'

const origin = process.env.PAPERAGENT_DSH_ORIGIN ?? 'http://127.0.0.1:3091'
const invalidSession = '__paperagent_remote_smoke__'

for (const entry of paperAgentRemoteContract) {
  const args = Object.fromEntries(entry.parameters.map(parameter => [parameter, sample(parameter)]))
  const response = await fetch(`${origin}/api/paperAgent/${entry.method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  const body = await response.text()
  if (response.status === 404) {
    throw new Error(`${entry.method}: HTTP 404 — restart DSH after rebuilding the PaperAgent bundle`)
  }
  if (!response.ok) throw new Error(`${entry.method}: HTTP ${response.status}: ${body}`)
  process.stdout.write(`OK ${entry.method}: endpoint reached (expected invalid-session rejection)\n`)
}

function sample(parameter: string): unknown {
  switch (parameter) {
    case 'sessionId': return invalidSession
    case 'name': return 'Remote contract smoke test'
    case 'libraryId': return null
    case 'filter': return {}
    case 'paperId': return '__missing_paper__'
    case 'figureId': return '__missing_figure__'
    case 'patch': return {}
    case 'input': return { fileName: 'smoke.pdf', base64: '', libraryId: null }
    case 'bibtex': return '@article{smoke, title={Smoke test}}'
    case 'jobId': return '__missing_parse_job__'
    default: throw new Error(`missing smoke sample for ${parameter}`)
  }
}
