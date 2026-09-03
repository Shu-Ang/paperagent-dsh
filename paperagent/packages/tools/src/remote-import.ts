import type { PaperAgentStore } from '@paperagent/domain'
import type { PaperParseJobs } from './parse-jobs.ts'
import { importResolvedCandidate } from './import/paper-import-service.ts'
import { resolvePaperReference } from './import/adapter-registry.ts'

export interface PaperImportRemoteConfig {
  readonly store: Promise<PaperAgentStore>
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs?: number
  readonly maxDownloadRedirects?: number
  readonly parseJobs: Pick<PaperParseJobs, 'start'>
}

/** Shared arXiv import flow for both the browser Remote and Agent tools. */
export async function importArxivPaperIntoWorkspace(
  config: PaperImportRemoteConfig,
  workspace: string,
  input: { url: string; libraryId: string | null },
) {
  const candidate = (await resolvePaperReference(input.url))[0]
  if (candidate === undefined) throw new Error('arXiv reference did not resolve to a paper candidate')
  return importResolvedCandidate(config, { workspacePath: workspace, libraryId: input.libraryId, candidate })
}

/** Imports a user-supplied public HTTPS PDF URL after bounded download checks. */
export async function importPdfUrlIntoWorkspace(
  config: PaperImportRemoteConfig,
  workspace: string,
  input: { url: string; libraryId: string | null; title?: string },
) {
  const candidate = (await resolvePaperReference(input.url))[0]
  if (candidate === undefined) throw new Error('PDF reference did not resolve to a paper candidate')
  const titledCandidate = input.title === undefined || input.title.trim() === '' ? candidate : { ...candidate, title: input.title }
  return importResolvedCandidate(config, { workspacePath: workspace, libraryId: input.libraryId, candidate: titledCandidate })
}
