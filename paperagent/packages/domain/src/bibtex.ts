import { normalizeYear, nullableText } from './normalizers.ts'

export function parseBibtexMetadata(bibtex: string): {
  readonly citationKey: string | null; readonly title: string | null; readonly authors: readonly string[]; readonly year: number | null
  readonly doi: string | null; readonly journal: string | null; readonly volume: string | null; readonly issue: string | null
  readonly pages: string | null; readonly url: string | null; readonly abstract: string | null; readonly keywords: string | null
} {
  const field = (name: string): string | null => {
    const match = new RegExp(`\\b${name}\\s*=\\s*`, 'i').exec(bibtex)
    if (match === null) return null
    return normalizeBibtexField(readBibtexValue(bibtex, match.index + match[0].length))
  }
  const authorText = field('author')
  const yearText = field('year')
  const year = yearText === null || !/^\d{1,4}$/.test(yearText) ? null : normalizeYear(Number(yearText))
  const citationKeyMatch = /@\w+\s*\{\s*([^,\s]+)/i.exec(bibtex)
  return {
    citationKey: citationKeyMatch?.[1] ?? null, title: field('title'),
    authors: authorText === null ? [] : authorText.split(/\s+and\s+/i).map(author => author.trim()).filter(Boolean),
    year, doi: field('doi'), journal: field('journal') ?? field('booktitle'), volume: field('volume'), issue: field('number'),
    pages: field('pages'), url: field('url'), abstract: field('abstract'), keywords: field('keywords'),
  }
}

/** A usable entry needs an entry type, citation key, and opening field separator. */
export function isValidBibtexEntry(bibtex: string): boolean {
  return /^\s*@[\w-]+\s*\{\s*[^,\s]+\s*,/i.test(bibtex)
}

/** Reads one BibTeX field value without treating a nested brace as its end. */
function readBibtexValue(source: string, start: number): string | null {
  const opener = source[start]
  if (opener === '{') {
    let depth = 0
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}' && --depth === 0) return source.slice(start + 1, index)
    }
    return null
  }
  if (opener === '"') {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '"' && source[index - 1] !== '\\') return source.slice(start + 1, index)
    }
    return null
  }
  const end = source.slice(start).search(/[,\r\n}]/)
  return end === -1 ? source.slice(start) : source.slice(start, start + end)
}

function normalizeBibtexField(value: string | null): string | null {
  return value === null ? null : nullableText(value.replace(/[{}]/g, '').replace(/\s+/g, ' '))
}


