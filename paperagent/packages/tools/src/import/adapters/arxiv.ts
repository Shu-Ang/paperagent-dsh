import type { PaperSourceAdapter } from '../source-types.ts'

export const arxivAdapter: PaperSourceAdapter = {
  id: 'arxiv',
  canHandle: reference => reference.kind === 'arxiv',
  async resolve(reference) {
    const arxivId = parseArxivId(reference.value)
    const metadata = await loadArxivMetadata(arxivId)
    return [{
      id: `arxiv:${arxivId}`,
      source: 'arXiv',
      canonicalUrl: `https://arxiv.org/abs/${arxivId}`,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      doi: metadata.doi,
      abstract: metadata.abstract,
      bibtex: metadata.bibtex,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
      confidence: 'high',
      provenance: [
        { source: 'arXiv Atom API', url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}` },
        { source: 'arXiv PDF', url: `https://arxiv.org/pdf/${arxivId}.pdf` },
      ],
    }]
  },
}

export function parseArxivId(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('please provide a valid arXiv paper URL') }
  if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname.toLowerCase())) {
    throw new Error('only official https://arxiv.org paper URLs are supported')
  }
  const path = decodeURIComponent(url.pathname).replace(/^\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '')
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/i.test(path)) {
    throw new Error('could not identify an arXiv paper id from this URL')
  }
  return path
}

interface ArxivMetadata {
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string | null
  readonly abstract: string
  readonly categories: readonly string[]
  readonly bibtex: string
}

async function loadArxivMetadata(arxivId: string): Promise<ArxivMetadata> {
  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
    headers: { accept: 'application/atom+xml, application/xml;q=0.9' }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`arXiv metadata request failed with HTTP ${response.status}`)
  const atom = await response.text()
  if (atom.length > 2 * 1024 * 1024) throw new Error('arXiv metadata response is unexpectedly large')
  const entry = atom.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1]
  if (entry === undefined) throw new Error('arXiv did not return metadata for this paper')
  const title = atomText(entry, 'title')
  if (title === '') throw new Error('arXiv metadata is missing a title')
  const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map(match => xmlText(match[1] ?? '')).filter(Boolean)
  const published = atomText(entry, 'published')
  const year = /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null
  const doi = atomText(entry, 'arxiv:doi') || atomText(entry, 'doi') || null
  const abstract = atomText(entry, 'summary')
  const categories = [...entry.matchAll(/<category\b[^>]*\bterm\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)]
    .map(match => xmlText(match[1] ?? '')).filter(Boolean)
  return { title, authors, year, doi, abstract, categories, bibtex: makeArxivBibtex({ arxivId, title, authors, year, doi, categories }) }
}

function atomText(source: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const value = source.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\/${escaped}>`, 'i'))?.[1] ?? ''
  return xmlText(value)
}

function xmlText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
}

function makeArxivBibtex(input: { arxivId: string; title: string; authors: readonly string[]; year: number | null; doi: string | null; categories: readonly string[] }): string {
  const citationKey = `arxiv_${input.arxivId.replaceAll('/', '_').replaceAll('.', '_')}`
  const field = (name: string, value: string) => `  ${name} = {${value.replaceAll('}', '\\}').replaceAll('{', '\\{')}},`
  const lines = [
    `@article{${citationKey},`, field('title', input.title), field('author', input.authors.join(' and ')),
    ...(input.year === null ? [] : [field('year', String(input.year))]), field('eprint', input.arxivId), field('archivePrefix', 'arXiv'),
    ...(input.categories[0] === undefined ? [] : [field('primaryClass', input.categories[0])]), field('url', `https://arxiv.org/abs/${input.arxivId}`),
    ...(input.doi === null ? [] : [field('doi', input.doi)]),
  ]
  return `${lines.join('\n')}\n}`
}
