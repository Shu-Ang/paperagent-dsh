import { arxivAdapter } from './adapters/arxiv.ts'
import { directPdfAdapter } from './adapters/direct-pdf.ts'
import { doiAdapter, normalizeDoi } from './adapters/doi.ts'
import { venuePdfAdapter } from './adapters/venue-pdf.ts'
import type { NormalizedPaperReference, PaperReferenceKind, PaperSourceAdapter, ResolvedPaperCandidate } from './source-types.ts'

const adapters: readonly PaperSourceAdapter[] = [arxivAdapter, doiAdapter, venuePdfAdapter, directPdfAdapter]

/** Converts one user-facing reference into a deterministic source-adapter input. */
export function normalizePaperReference(input: string): NormalizedPaperReference {
  const value = input.trim()
  if (value === '') throw new Error('paper reference must not be empty')
  if (isArxivUrl(value)) return { kind: 'arxiv', value }
  if (isDoi(value)) return { kind: 'doi', value: normalizeDoi(value) }
  if (isHttpsUrl(value)) return { kind: 'url', value: new URL(value).toString() }
  return { kind: 'title', value }
}

/** Returns only candidates resolved by the known deterministic adapters. */
export async function resolvePaperReference(input: string): Promise<readonly ResolvedPaperCandidate[]> {
  const reference = normalizePaperReference(input)
  const adapter = adapters.find(item => item.canHandle(reference))
  if (adapter === undefined) {
    if (reference.kind === 'title') throw new Error('paper title discovery requires web_search evidence before it can be resolved')
    throw new Error('this URL is not a supported paper source or direct PDF URL')
  }
  return adapter.resolve(reference)
}

export function paperReferenceKind(input: string): PaperReferenceKind {
  return normalizePaperReference(input).kind
}

function isArxivUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname.toLowerCase())
  } catch { return false }
}

function isDoi(value: string): boolean {
  try { normalizeDoi(value); return true } catch { return false }
}

function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
