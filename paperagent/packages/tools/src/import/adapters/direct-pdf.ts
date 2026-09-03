import type { PaperSourceAdapter } from '../source-types.ts'

export const directPdfAdapter: PaperSourceAdapter = {
  id: 'direct-pdf',
  // Some institutional repositories use download endpoints without a .pdf
  // suffix. The downloader verifies the actual PDF signature before import.
  canHandle: reference => reference.kind === 'url' && isHttpsUrl(reference.value),
  async resolve(reference) {
    const url = new URL(reference.value)
    const title = decodeURIComponent(url.pathname).split('/').filter(Boolean).at(-1)?.replace(/\.pdf$/i, '') || 'Untitled paper'
    return [{
      id: `pdf:${url.toString()}`,
      source: 'Direct PDF',
      canonicalUrl: url.toString(),
      title,
      authors: [],
      year: null,
      doi: null,
      abstract: null,
      bibtex: null,
      pdfUrl: url.toString(),
      confidence: 'medium',
      provenance: [{ source: 'Direct PDF URL', url: url.toString() }],
    }]
  },
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch { return false }
}
