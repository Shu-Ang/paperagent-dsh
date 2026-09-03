import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { PaperCitation, PaperRecord, PaperSectionOutline, PaperSectionRead } from '../models.ts'
import type { FindInPaperMarkdownInput, ReadPaperSectionInput } from '../inputs.ts'
import type { PaperChunkRow, PaperSectionRow } from '../rows.ts'
import { paperArtifactPaths } from '../paths.ts'
import { requireNonBlank } from '../validation.ts'

interface MarkdownSourceMapLocation {
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
}

/** Lists the current heading tree in document order. */
export function listPaperSections(
  db: DatabaseSync,
  workspacePath: string,
  paperId: string,
  getPaper: (workspacePath: string, paperId: string) => PaperRecord,
): PaperSectionOutline[] {
  const paper = getPaper(workspacePath, paperId)
  const sectionRows = db.prepare(`
    SELECT * FROM paper_sections
    WHERE workspace_path = ? AND paper_id = ? AND level > 0
    ORDER BY reading_order ASC
  `).all(paper.workspacePath, paper.id) as unknown as PaperSectionRow[]
  return sectionRows.map(row => ({
    id: row.id, ...(row.parent_id === null ? {} : { parentId: row.parent_id }), path: row.path, title: row.title, level: row.level,
    pdfPageStart: row.pdf_page_start, pdfPageEnd: row.pdf_page_end, lineStart: row.line_start, lineEnd: row.line_end,
  }))
}

export async function findInPaperMarkdown(
  db: DatabaseSync,
  input: FindInPaperMarkdownInput,
  getPaper: (workspacePath: string, paperId: string) => PaperRecord,
): Promise<PaperCitation[]> {
  const paper = getPaper(input.workspacePath, input.paperId)
  const query = requireNonBlank(input.query, 'search query')
  if (query.length > 256) throw new Error('search query exceeds the 256-character limit')
  const mode = input.mode ?? 'literal'
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50)
  const matcher = mode === 'regex' ? safeRegex(query) : undefined
  const startedAt = Date.now()
  const paths = paperArtifactPaths(paper)
  const [markdown, sourceMap] = await Promise.all([readFile(paths.markdown, 'utf8'), readMarkdownSourceMap(paths.sourceMap)])
  const lines = markdown.split(/\r?\n/)
  const citations: PaperCitation[] = []
  for (let index = 0; index < lines.length && citations.length < limit; index += 1) {
    if (Date.now() - startedAt > 1_000) throw new Error('exact Markdown search exceeded the 1000ms limit')
    const line = lines[index] ?? ''
    const matched = matcher === undefined ? line.includes(query) : testRegex(matcher, line)
    if (!matched) continue
    const source = db.prepare(`
      SELECT * FROM paper_chunks
      WHERE workspace_path = ? AND paper_id = ? AND line_start <= ? AND line_end >= ?
      ORDER BY line_start ASC LIMIT 1
    `).get(paper.workspacePath, paper.id, index + 1, index + 1) as PaperChunkRow | undefined
    const mapped = source === undefined ? sourceMapLocationAt(sourceMap, index + 1) : undefined
    citations.push({
      id: source?.id ?? `markdown:${paper.id}:${index + 1}`,
      paperId: paper.id,
      title: paper.title,
      authors: paper.authors,
      ...(paper.year === null ? {} : { year: paper.year }),
      section: source?.section ?? mapped?.section ?? 'Document',
      ...(source !== undefined ? { pdfPageStart: source.pdf_page_start, pdfPageEnd: source.pdf_page_end } : mapped === undefined ? {} : { pdfPageStart: mapped.pdfPageStart, pdfPageEnd: mapped.pdfPageEnd }),
      markdownPath: paths.markdown,
      lineStart: index + 1,
      lineEnd: index + 1,
      excerpt: line.slice(0, 700),
    })
  }
  return citations
}

export async function readPaperSection(
  db: DatabaseSync,
  input: ReadPaperSectionInput,
  getPaper: (workspacePath: string, paperId: string) => PaperRecord,
): Promise<PaperSectionRead> {
  const paper = getPaper(input.workspacePath, input.paperId)
  const explicitLines = input.lineStart !== undefined || input.lineEnd !== undefined
  if (input.section !== undefined && explicitLines) throw new Error('provide either a section or both line bounds, not both')
  let lineStart: number
  let lineEnd: number
  let chunk: PaperChunkRow | undefined
  if (input.section !== undefined) {
    const requestedSection = requireNonBlank(input.section, 'section')
    const section = resolveSection(db, paper.workspacePath, paper.id, requestedSection)
    if (section === undefined) throw new Error(`section "${requestedSection}" was not found in this paper; reparse the paper before reading by section`)
    const sectionIds = descendantSectionIds(db, paper.workspacePath, paper.id, section.id)
    const chunks = db.prepare(`
      SELECT * FROM paper_chunks
      WHERE workspace_path = ? AND paper_id = ? AND section_id IN (${sectionIds.map(() => '?').join(', ')})
      ORDER BY line_start ASC
    `).all(paper.workspacePath, paper.id, ...sectionIds) as unknown as PaperChunkRow[]
    if (chunks.length === 0) throw new Error(`section "${section.title}" has no readable chunks in this paper`)
    const first = chunks[0]
    const last = chunks.at(-1)
    if (first === undefined || last === undefined) throw new Error(`section "${section.title}" has no readable chunks in this paper`)
    lineStart = first.line_start
    lineEnd = last.line_end
    chunk = first
  } else {
    if (input.lineStart === undefined || input.lineEnd === undefined) throw new Error('provide a section or both line_start and line_end')
    lineStart = Math.trunc(input.lineStart)
    lineEnd = Math.trunc(input.lineEnd)
    if (lineStart < 1 || lineEnd < lineStart || lineEnd - lineStart > 499) throw new Error('line range must be between 1 and 500 lines')
    chunk = db.prepare(`
      SELECT * FROM paper_chunks WHERE workspace_path = ? AND paper_id = ? AND line_start <= ? AND line_end >= ?
      ORDER BY line_start ASC LIMIT 1
    `).get(paper.workspacePath, paper.id, lineStart, lineStart) as PaperChunkRow | undefined
  }
  const paths = paperArtifactPaths(paper)
  const [markdown, sourceMap] = await Promise.all([readFile(paths.markdown, 'utf8'), readMarkdownSourceMap(paths.sourceMap)])
  const lines = markdown.split(/\r?\n/)
  if (lineStart > lines.length) throw new Error('line range starts after the end of this paper')
  lineEnd = Math.min(lineEnd, lines.length)
  const maxChars = Math.min(Math.max(Math.trunc(input.maxChars ?? 6_000), 256), 12_000)
  const raw = lines.slice(lineStart - 1, lineEnd).join('\n')
  const truncated = raw.length > maxChars
  const content = raw.slice(0, maxChars)
  const mapped = chunk === undefined ? sourceMapLocationAt(sourceMap, lineStart) : undefined
  const citation: PaperCitation = {
    id: chunk?.id ?? `markdown:${paper.id}:${lineStart}-${lineEnd}`,
    paperId: paper.id,
    title: paper.title,
    authors: paper.authors,
    ...(paper.year === null ? {} : { year: paper.year }),
    section: chunk?.section ?? mapped?.section ?? input.section ?? 'Document',
    ...(chunk !== undefined ? { pdfPageStart: chunk.pdf_page_start, pdfPageEnd: chunk.pdf_page_end } : mapped === undefined ? {} : { pdfPageStart: mapped.pdfPageStart, pdfPageEnd: mapped.pdfPageEnd }),
    markdownPath: paths.markdown,
    lineStart,
    lineEnd,
    excerpt: content.slice(0, 700),
  }
  return { citation, content, truncated }
}

/**
 * MinerU headings are data, not an author-controlled API. Accept harmless
 * formatting variance and an unambiguous heading number, but never guess a
 * semantically different title such as "Approach" for "MS-DETR".
 */
function resolveSection(db: DatabaseSync, workspacePath: string, paperId: string, requested: string): PaperSectionRow | undefined {
  const sections = db.prepare(`
    SELECT *
    FROM paper_sections
    WHERE workspace_path = ? AND paper_id = ?
    ORDER BY reading_order ASC
  `).all(workspacePath, paperId) as unknown as PaperSectionRow[]
  const exact = sections.find(candidate => candidate.title === requested || candidate.path === requested)
  if (exact !== undefined) return exact

  const normalized = normalizeSectionTitle(requested)
  const normalizedMatches = sections.filter(candidate => normalizeSectionTitle(candidate.title) === normalized || normalizeSectionTitle(candidate.path) === normalized)
  if (normalizedMatches.length === 1) return normalizedMatches[0]

  const number = headingNumber(requested)
  if (number !== undefined) {
    const numberedMatches = sections.filter(candidate => headingNumber(candidate.title) === number)
    if (numberedMatches.length === 1) return numberedMatches[0]
  }

  if (sections.length === 0) return undefined
  const available = sections.slice(0, 12).map(candidate => `"${candidate.title}"`).join(', ')
  const suffix = sections.length > 12 ? ', …' : ''
  throw new Error(
    `section "${requested}" was not found in this paper. Available sections: ${available}${suffix}. `
    + 'Use the exact section returned by search_paper_library, or use line_start and line_end from its citation.',
  )
}

function descendantSectionIds(db: DatabaseSync, workspacePath: string, paperId: string, rootId: string): string[] {
  const rows = db.prepare('SELECT id, parent_id FROM paper_sections WHERE workspace_path = ? AND paper_id = ?').all(workspacePath, paperId) as unknown as Array<{ id: string; parent_id: string | null }>
  const ids = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (row.parent_id !== null && ids.has(row.parent_id) && !ids.has(row.id)) { ids.add(row.id); changed = true }
  }
  return [...ids]
}

function normalizeSectionTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s.:：、_\-–—]+/gu, '')
}

function headingNumber(value: string): string | undefined {
  const match = /^(\d+(?:\.\d+)*)\.?($|\s)/u.exec(value.trim())
  return match?.[1]
}

async function readMarkdownSourceMap(path: string): Promise<readonly MarkdownSourceMapLocation[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { chunks?: unknown }).chunks)) return []
    return (parsed as { chunks: unknown[] }).chunks.flatMap(chunk => {
      if (typeof chunk !== 'object' || chunk === null) return []
      const value = chunk as Record<string, unknown>
      const section = typeof value.section === 'string' ? value.section.trim() : ''
      const numbers = ['pdfPageStart', 'pdfPageEnd', 'lineStart', 'lineEnd'].map(key => value[key])
      if (section === '' || numbers.some(value => !Number.isInteger(value) || (value as number) < 1)) return []
      return [{ section, pdfPageStart: numbers[0] as number, pdfPageEnd: numbers[1] as number, lineStart: numbers[2] as number, lineEnd: numbers[3] as number }]
    })
  } catch {
    return []
  }
}

function sourceMapLocationAt(locations: readonly MarkdownSourceMapLocation[], line: number): MarkdownSourceMapLocation | undefined {
  return locations.find(location => location.lineStart <= line && location.lineEnd >= line)
}

function safeRegex(source: string): RegExp {
  if (source.length > 256) throw new Error('regular expression exceeds the 256-character limit')
  if (/\\[1-9]|\\k<|\(\?<=[\s\S]|\(\?<!/.test(source)) throw new Error('regular expression backreferences and lookbehind are not allowed')
  if (/(?:\*|\+|\}|\?)[^()]{0,64}\)(?:\*|\+|\{|\?)/.test(source)) throw new Error('regular expression nested quantifiers are not allowed')
  try { return new RegExp(source, 'u') } catch { throw new Error('invalid regular expression') }
}

function testRegex(expression: RegExp, value: string): boolean {
  expression.lastIndex = 0
  return expression.test(value)
}
