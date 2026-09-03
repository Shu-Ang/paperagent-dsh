/** Stable public PDF routes for common paper venues. Metadata is only used when it is source-provided. */

import type { PaperSourceAdapter, ResolvedPaperCandidate } from '../source-types.ts'

export const venuePdfAdapter: PaperSourceAdapter = {
  id: 'venue-pdf',
  canHandle(reference) {
    if (reference.kind !== 'url') return false
    const hostname = new URL(reference.value).hostname.toLowerCase()
    return hostname === 'openreview.net' || hostname === 'www.openreview.net'
      || hostname === 'aclanthology.org' || hostname === 'www.aclanthology.org'
      || hostname === 'openaccess.thecvf.com'
  },
  async resolve(reference) {
    const url = new URL(reference.value)
    const hostname = url.hostname.toLowerCase()
    if (hostname.includes('openreview.net')) return [openReviewCandidate(url)]
    if (hostname.includes('aclanthology.org')) return [await aclCandidate(url)]
    return [cvfCandidate(url)]
  },
}

function openReviewCandidate(url: URL): ResolvedPaperCandidate {
  const id = url.searchParams.get('id')?.trim()
  if (id === undefined || id === '') throw new Error('OpenReview URLs must include a public paper id')
  const canonicalUrl = `https://openreview.net/forum?id=${encodeURIComponent(id)}`
  const pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(id)}`
  return candidate({
    id: `openreview:${id}`, source: 'OpenReview', canonicalUrl, pdfUrl,
    title: `OpenReview paper ${id}`, year: null, bibtex: null,
    provenance: [{ source: 'OpenReview forum', url: canonicalUrl }, { source: 'OpenReview PDF', url: pdfUrl }],
  })
}

async function aclCandidate(url: URL): Promise<ResolvedPaperCandidate> {
  const identifier = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.(?:pdf|bib)$/i, '')
  if (identifier === '') throw new Error('ACL Anthology URL must identify one paper')
  const canonicalUrl = `https://aclanthology.org/${identifier}/`
  const pdfUrl = `https://aclanthology.org/${identifier}.pdf`
  const bibUrl = `https://aclanthology.org/${identifier}.bib`
  const bibtex = await fetchAclBibtex(bibUrl).catch(() => null)
  const parsed = bibtex === null ? null : parseBibtex(bibtex)
  return candidate({
    id: `acl:${identifier}`, source: 'ACL Anthology', canonicalUrl, pdfUrl,
    title: parsed?.title ?? identifier, year: parsed?.year ?? yearFromIdentifier(identifier), bibtex,
    authors: parsed?.authors ?? [], doi: parsed?.doi ?? null,
    provenance: [
      { source: 'ACL Anthology page', url: canonicalUrl }, { source: 'ACL Anthology PDF', url: pdfUrl },
      ...(bibtex === null ? [] : [{ source: 'ACL Anthology BibTeX', url: bibUrl }]),
    ],
  })
}

function cvfCandidate(url: URL): ResolvedPaperCandidate {
  const pdfUrl = url.toString()
  const name = decodeURIComponent(url.pathname).split('/').at(-1)?.replace(/_paper\.pdf$/i, '').replace(/\.pdf$/i, '') || 'CVF paper'
  return candidate({
    id: `cvf:${pdfUrl}`, source: 'CVF Open Access', canonicalUrl: pdfUrl, pdfUrl, title: name, year: null, bibtex: null,
    provenance: [{ source: 'CVF Open Access PDF', url: pdfUrl }],
  })
}

async function fetchAclBibtex(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'application/x-bibtex, text/plain;q=0.8' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`ACL Anthology BibTeX request failed with HTTP ${response.status}`)
  const bibtex = await response.text()
  if (!/^\s*@\w+\s*\{/i.test(bibtex)) throw new Error('ACL Anthology response is not BibTeX')
  return bibtex
}

function parseBibtex(bibtex: string): { readonly title: string; readonly authors: readonly string[]; readonly year: number | null; readonly doi: string | null } | null {
  const value = (field: string) => bibtex.match(new RegExp(`\\b${field}\\s*=\\s*[{"]([^}"]+)`, 'i'))?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  const title = value('title')
  if (title === '') return null
  const yearText = value('year')
  return {
    title, authors: value('author').split(/\s+and\s+/i).filter(Boolean),
    year: /^\d{4}$/.test(yearText) ? Number(yearText) : null,
    doi: value('doi') || null,
  }
}

function yearFromIdentifier(identifier: string): number | null {
  const year = identifier.match(/^(19|20)\d{2}/)?.[0]
  return year === undefined ? null : Number(year)
}

function candidate(input: {
  readonly id: string; readonly source: string; readonly canonicalUrl: string; readonly pdfUrl: string; readonly title: string
  readonly year: number | null; readonly bibtex: string | null; readonly provenance: ResolvedPaperCandidate['provenance']
  readonly authors?: readonly string[]; readonly doi?: string | null
}): ResolvedPaperCandidate {
  return {
    id: input.id, source: input.source, canonicalUrl: input.canonicalUrl, title: input.title, authors: input.authors ?? [], year: input.year,
    doi: input.doi ?? null, abstract: null, bibtex: input.bibtex, pdfUrl: input.pdfUrl, confidence: input.bibtex === null ? 'medium' : 'high', provenance: input.provenance,
  }
}
