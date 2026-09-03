import type { PaperSourceAdapter, SourceProvenance } from '../source-types.ts'

interface CrossrefAuthor { readonly given?: string; readonly family?: string; readonly name?: string }
interface CrossrefMessage {
  readonly title?: readonly string[]
  readonly author?: readonly CrossrefAuthor[]
  readonly DOI?: string
  readonly abstract?: string
  readonly 'container-title'?: readonly string[]
  readonly volume?: string
  readonly issue?: string
  readonly page?: string
  readonly URL?: string
  readonly issued?: { readonly 'date-parts'?: readonly (readonly number[])[] }
}

export const doiAdapter: PaperSourceAdapter = {
  id: 'doi',
  canHandle: reference => reference.kind === 'doi',
  async resolve(reference) {
    const doi = normalizeDoi(reference.value)
    const crossref = await fetchCrossref(doi)
    const title = crossref.title?.[0]?.trim()
    if (title === undefined || title === '') throw new Error('Crossref metadata is missing a paper title')
    const authors = (crossref.author ?? []).map(formatAuthor).filter(Boolean)
    const year = crossref.issued?.['date-parts']?.[0]?.[0] ?? null
    const openAccessPdf = await findOpenAlexPdf(doi).catch(() => null)
    const canonicalUrl = `https://doi.org/${doi}`
    const provenance: SourceProvenance[] = [{ source: 'Crossref', url: `https://api.crossref.org/works/${encodeURIComponent(doi)}` }]
    if (openAccessPdf !== null) provenance.push({ source: 'OpenAlex open access location', url: openAccessPdf })
    return [{
      id: `doi:${doi.toLowerCase()}`,
      source: 'DOI',
      canonicalUrl,
      title,
      authors,
      year: Number.isSafeInteger(year) ? year : null,
      doi,
      abstract: plainText(crossref.abstract ?? '') || null,
      bibtex: makeDoiBibtex({ doi, title, authors, year: Number.isSafeInteger(year) ? year : null, message: crossref, canonicalUrl }),
      pdfUrl: openAccessPdf,
      confidence: 'high',
      provenance,
    }]
  },
}

export function normalizeDoi(input: string): string {
  const trimmed = input.trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  const decoded = decodeURIComponent(trimmed).replace(/[\s.]+$/, '')
  if (!/^10\.\d{4,9}\/.+$/i.test(decoded)) throw new Error('please provide a valid DOI')
  return decoded
}

async function fetchCrossref(doi: string): Promise<CrossrefMessage> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Crossref metadata request failed with HTTP ${response.status}`)
  const payload = await response.json() as { message?: CrossrefMessage }
  if (payload.message === undefined) throw new Error('Crossref metadata response is missing a message')
  return payload.message
}

async function findOpenAlexPdf(doi: string): Promise<string | null> {
  const response = await fetch(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) return null
  const payload = await response.json() as {
    best_oa_location?: { pdf_url?: string | null }
    open_access?: { oa_url?: string | null }
  }
  const candidate = payload.best_oa_location?.pdf_url ?? payload.open_access?.oa_url ?? null
  if (candidate === null) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

function formatAuthor(author: CrossrefAuthor): string {
  if (author.name !== undefined && author.name.trim() !== '') return author.name.trim()
  return [author.family, author.given].filter((value): value is string => value !== undefined && value.trim() !== '').join(', ')
}

function plainText(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function makeDoiBibtex(input: { doi: string; title: string; authors: readonly string[]; year: number | null; message: CrossrefMessage; canonicalUrl: string }): string {
  const field = (name: string, value: string) => `  ${name} = {${value.replaceAll('}', '\\}').replaceAll('{', '\\{')}},`
  const citationKey = `doi_${input.doi.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96)}`
  const lines = [
    `@article{${citationKey},`, field('title', input.title),
    ...(input.authors.length === 0 ? [] : [field('author', input.authors.join(' and '))]),
    ...(input.year === null ? [] : [field('year', String(input.year))]),
    ...(input.message['container-title']?.[0] === undefined ? [] : [field('journal', input.message['container-title'][0])]),
    ...(input.message.volume === undefined ? [] : [field('volume', input.message.volume)]),
    ...(input.message.issue === undefined ? [] : [field('number', input.message.issue)]),
    ...(input.message.page === undefined ? [] : [field('pages', input.message.page)]),
    field('doi', input.doi), field('url', input.canonicalUrl),
  ]
  return `${lines.join('\n')}\n}`
}
