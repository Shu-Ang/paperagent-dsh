export function normalizedTitle(title: string | undefined, sourceName: string): string {
  if (title !== undefined && title.trim() !== '') return title.trim()
  return sourceName.replace(/\.pdf$/i, '')
}

export function safeFigureRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized.startsWith('images/') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('figure path must be a managed images-relative path')
  }
  return normalized
}

export function normalizeAuthors(authors: readonly string[] | undefined): readonly string[] {
  return authors?.map(author => author.trim()).filter(author => author !== '') ?? []
}

export function optionalText(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

export function nullableText(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value.trim()
}

export function normalizeYear(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isInteger(value) || value < 0 || value > 9999) throw new Error('paper year must be a four-digit number')
  return value
}


