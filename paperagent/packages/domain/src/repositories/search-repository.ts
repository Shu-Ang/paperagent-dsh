import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { PaperCitation, PaperElementCitation, PaperElementRead, PaperElementType, PaperFigureCitation, PaperSearchFilter } from '../models.ts'
import type { ReadPaperElementInput, SearchPaperElementsInput } from '../inputs.ts'
import type { PaperChunkRow, PaperElementRow, PaperFigureRow } from '../rows.ts'
import { elementFilterSql, chunkFilterSql } from '../search-filters.ts'
import { parseStringArray } from '../validation.ts'
import { toPaperFigureCitation, toPaperFigureRecord } from '../row-mappers.ts'
import { canonicalWorkspace, workspaceDataPath } from '../paths.ts'
import { requireNonBlank } from '../validation.ts'
import { figureFtsText } from '../figure-text.ts'

export function searchPaperChunks(db: DatabaseSync, fts5Enabled: boolean, workspacePath: string, query: string, limit = 6, filter: PaperSearchFilter = {}): PaperCitation[] {
  const workspace = canonicalWorkspace(workspacePath)
  const normalizedQuery = requireNonBlank(query, 'search query').toLocaleLowerCase()
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 20)
  const ftsQuery = ftsQueryFor(normalizedQuery)
  if (fts5Enabled && ftsQuery !== '') {
    try {
      const { where, parameters } = chunkFilterSql(workspace, filter, 'c', 'p')
      const rows = db.prepare(`
        SELECT c.*, p.title AS paper_title, p.authors AS paper_authors, p.year AS paper_year,
               p.relative_dir AS paper_relative_dir, bm25(paper_chunks_fts) AS rank
        FROM paper_chunks_fts
        JOIN paper_chunks c ON c.id = paper_chunks_fts.chunk_id
        JOIN papers p ON p.id = c.paper_id AND p.workspace_path = c.workspace_path
        WHERE paper_chunks_fts MATCH ? AND ${where}
        ORDER BY rank ASC, c.pdf_page_start ASC
        LIMIT ?
      `).all(ftsQuery, ...parameters, safeLimit) as unknown as Array<PaperChunkRow & PaperChunkCitationRow>
      if (rows.length > 0) return rows.map(row => toCitation(workspace, row))
    } catch {
      // Fall back to bounded lexical scoring if FTS5 is unavailable or malformed.
    }
  }
  const tokens = [...new Set(normalizedQuery.split(/\s+/).filter(token => token.length >= 2))]
  const { where, parameters } = chunkFilterSql(workspace, filter)
  const rows = db.prepare(`
    SELECT c.*, p.title AS paper_title, p.authors AS paper_authors, p.year AS paper_year,
           p.relative_dir AS paper_relative_dir
    FROM paper_chunks c
    JOIN papers p ON p.id = c.paper_id AND p.workspace_path = c.workspace_path
    WHERE ${where}
  `).all(...parameters) as unknown as Array<PaperChunkRow & PaperChunkCitationRow>
  return rows
    .map(row => ({ row, score: relevanceScore(row.content, normalizedQuery, tokens) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.row.pdf_page_start - right.row.pdf_page_start)
    .slice(0, safeLimit)
    .map(({ row }) => toCitation(workspace, row))
}

/**
 * Rehydrates a bounded, externally ranked chunk-id list from local facts.
 * Vector backends may nominate ids but never become a source of citation
 * coordinates, text, ownership, or parse-state truth.
 */
export function getPaperChunkCitationsByIds(
  db: DatabaseSync,
  workspacePath: string,
  chunkIds: readonly string[],
  filter: PaperSearchFilter = {},
): PaperCitation[] {
  const workspace = canonicalWorkspace(workspacePath)
  const orderedIds = [...new Set(chunkIds.map(id => id.trim()).filter(id => id !== ''))].slice(0, 100)
  if (orderedIds.length === 0) return []
  const { where, parameters } = chunkFilterSql(workspace, filter, 'c', 'p')
  const placeholders = orderedIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT c.*, p.title AS paper_title, p.authors AS paper_authors, p.year AS paper_year,
           p.relative_dir AS paper_relative_dir
    FROM paper_chunks c
    JOIN papers p ON p.id = c.paper_id AND p.workspace_path = c.workspace_path
    WHERE ${where} AND c.id IN (${placeholders})
  `).all(...parameters, ...orderedIds) as unknown as Array<PaperChunkRow & PaperChunkCitationRow>
  const byId = new Map(rows.map(row => [row.id, toCitation(workspace, row)]))
  return orderedIds.flatMap(id => {
    const citation = byId.get(id)
    return citation === undefined ? [] : [citation]
  })
}

/**
 * Rehydrates externally ranked element identities from current SQLite facts.
 * This applies the same ownership, ready-parse, type, and structured filters
 * as FTS before an Elasticsearch candidate can become Agent evidence.
 */
export function getPaperElementCitationsByIds(
  db: DatabaseSync,
  workspacePath: string,
  elementIds: readonly string[],
  input: { readonly types?: readonly PaperElementType[]; readonly filter?: PaperSearchFilter } = {},
): PaperElementCitation[] {
  const workspace = canonicalWorkspace(workspacePath)
  const orderedIds = normalizedIds(elementIds)
  if (orderedIds.length === 0) return []
  const { where, parameters } = elementFilterSql(workspace, input.types ?? [], input.filter)
  const placeholders = orderedIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT e.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir
    FROM paper_elements e
    JOIN papers p ON p.id = e.paper_id AND p.workspace_path = e.workspace_path
    WHERE ${where} AND e.id IN (${placeholders})
  `).all(...parameters, ...orderedIds) as unknown as Array<PaperElementRow & PaperElementCitationRow>
  const byId = new Map(rows.map(row => [row.id, toPaperElementCitation(workspace, row, row.content.slice(0, 1_200))]))
  return orderedIds.flatMap(id => {
    const citation = byId.get(id)
    return citation === undefined ? [] : [citation]
  })
}

export function searchPaperElements(db: DatabaseSync, fts5Enabled: boolean, input: SearchPaperElementsInput): PaperElementCitation[] {
  const workspace = canonicalWorkspace(input.workspacePath)
  const normalizedQuery = requireNonBlank(input.query, 'element search query').toLocaleLowerCase()
  const safeLimit = Math.min(Math.max(Math.trunc(input.limit ?? 6), 1), 20)
  const types = [...new Set(input.types ?? [])]
  const { where, parameters } = elementFilterSql(workspace, types, input.filter)
  const ftsQuery = ftsQueryFor(normalizedQuery)
  if (fts5Enabled && ftsQuery !== '') {
    try {
      const rows = db.prepare(`
        SELECT e.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir, bm25(paper_elements_fts) AS rank
        FROM paper_elements_fts
        JOIN paper_elements e ON e.id = paper_elements_fts.element_id
        JOIN papers p ON p.id = e.paper_id AND p.workspace_path = e.workspace_path
        WHERE paper_elements_fts MATCH ? AND ${where}
        ORDER BY rank ASC, e.pdf_page_start ASC, e.reading_order ASC LIMIT ?
      `).all(ftsQuery, ...parameters, safeLimit) as unknown as Array<PaperElementRow & PaperElementCitationRow>
      if (rows.length > 0) return rows.map(row => toPaperElementCitation(workspace, row, row.content.slice(0, 1_200)))
    } catch {
      // Fall back to bounded lexical scoring if FTS5 is unavailable or malformed.
    }
  }
  const rows = db.prepare(`
    SELECT e.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir
    FROM paper_elements e
    JOIN papers p ON p.id = e.paper_id AND p.workspace_path = e.workspace_path
    WHERE ${where}
  `).all(...parameters) as unknown as Array<PaperElementRow & PaperElementCitationRow>
  const tokens = [...new Set(normalizedQuery.split(/\s+/).filter(token => token.length >= 2))]
  return rows
    .map(row => ({ row, score: relevanceScore(elementSearchText(row), normalizedQuery, tokens) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.row.pdf_page_start - right.row.pdf_page_start || left.row.reading_order - right.row.reading_order)
    .slice(0, safeLimit)
    .map(({ row }) => toPaperElementCitation(workspace, row, row.content.slice(0, 1_200)))
}

export function readPaperElement(db: DatabaseSync, input: ReadPaperElementInput): PaperElementRead {
  const workspace = canonicalWorkspace(input.workspacePath)
  const { where, parameters } = elementFilterSql(workspace, [])
  const row = db.prepare(`
    SELECT e.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir
    FROM paper_elements e JOIN papers p ON p.id = e.paper_id AND p.workspace_path = e.workspace_path
    WHERE ${where} AND e.id = ?
  `).get(...parameters, requireNonBlank(input.elementId, 'element id')) as PaperElementRow & PaperElementCitationRow | undefined
  if (row === undefined) throw new Error('paper element not found in the active workspace')
  const maxChars = Math.min(Math.max(Math.trunc(input.maxChars ?? 6_000), 256), 12_000)
  const content = row.content.slice(0, maxChars)
  return { citation: toPaperElementCitation(workspace, row, content), content, truncated: row.content.length > maxChars }
}

export function searchPaperFigures(db: DatabaseSync, fts5Enabled: boolean, workspacePath: string, query: string, limit = 6): PaperFigureCitation[] {
  const workspace = canonicalWorkspace(workspacePath)
  const normalizedQuery = requireNonBlank(query, 'search query').toLocaleLowerCase()
  const ftsQuery = ftsQueryFor(normalizedQuery)
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 20)
  if (fts5Enabled && ftsQuery !== '') {
    try {
      const rows = db.prepare(`
        SELECT f.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir FROM paper_figures_fts
        JOIN paper_figures f ON f.id = paper_figures_fts.figure_id
        JOIN papers p ON p.id = f.paper_id AND p.workspace_path = f.workspace_path
        WHERE paper_figures_fts MATCH ? AND f.workspace_path = ? AND p.parse_status = 'ready'
        ORDER BY bm25(paper_figures_fts) ASC, f.page_number ASC LIMIT ?
      `).all(ftsQuery, workspace, safeLimit) as unknown as Array<PaperFigureRow & { paper_title: string; paper_relative_dir: string }>
      if (rows.length > 0) return rows.map(row => toPaperFigureCitation(workspace, row))
    } catch {
      // A missing FTS5 extension must never make locally stored figures invisible.
    }
  }
  const tokens = [...new Set(normalizedQuery.split(/\s+/).filter(token => token.length >= 2))]
  const rows = db.prepare(`
    SELECT f.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir
    FROM paper_figures f
    JOIN papers p ON p.id = f.paper_id AND p.workspace_path = f.workspace_path
    WHERE f.workspace_path = ? AND p.parse_status = 'ready'
  `).all(workspace) as unknown as Array<PaperFigureRow & { paper_title: string; paper_relative_dir: string }>
  return rows
    .map(row => ({ row, score: relevanceScore(figureFtsText(toPaperFigureRecord(row)), normalizedQuery, tokens) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.row.page_number - right.row.page_number)
    .slice(0, safeLimit)
    .map(({ row }) => toPaperFigureCitation(workspace, row))
}

/**
 * Maps vectorised figure-element identities back to managed figure records.
 * Figures without a structured element intentionally cannot be returned by
 * vector search and remain available through the local FTS fallback.
 */
export function getPaperFigureCitationsByElementIds(
  db: DatabaseSync,
  workspacePath: string,
  elementIds: readonly string[],
): PaperFigureCitation[] {
  const workspace = canonicalWorkspace(workspacePath)
  const orderedIds = normalizedIds(elementIds)
  if (orderedIds.length === 0) return []
  const placeholders = orderedIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT f.*, p.title AS paper_title, p.relative_dir AS paper_relative_dir
    FROM paper_figures f
    JOIN papers p ON p.id = f.paper_id AND p.workspace_path = f.workspace_path
    WHERE f.workspace_path = ? AND p.parse_status = 'ready'
      AND f.element_id IN (${placeholders})
  `).all(workspace, ...orderedIds) as unknown as Array<PaperFigureRow & { paper_title: string; paper_relative_dir: string }>
  const byElementId = new Map(rows.flatMap(row => row.element_id === null
    ? []
    : [[row.element_id, toPaperFigureCitation(workspace, row)] as const]))
  return orderedIds.flatMap(id => {
    const citation = byElementId.get(id)
    return citation === undefined ? [] : [citation]
  })
}

export function toCitation(workspace: string, row: PaperChunkRow & PaperChunkCitationRow): PaperCitation {
  return {
    id: row.id,
    paperId: row.paper_id,
    title: row.paper_title,
    authors: parseStringArray(row.paper_authors, 'paper authors'),
    ...(row.paper_year === null ? {} : { year: row.paper_year }),
    section: row.section,
    pdfPageStart: row.pdf_page_start,
    pdfPageEnd: row.pdf_page_end,
    markdownPath: workspaceDataPath(workspace, join(row.paper_relative_dir, 'paper.md')),
    lineStart: row.line_start,
    lineEnd: row.line_end,
    excerpt: row.content.slice(0, 700),
  }
}

export function toPaperElementCitation(workspace: string, row: PaperElementRow & PaperElementCitationRow, content = row.content): PaperElementCitation {
  return {
    id: row.id,
    paperId: row.paper_id,
    title: row.paper_title,
    elementType: row.element_type,
    elementLabel: row.caption,
    section: row.section,
    pdfPageStart: row.pdf_page_start,
    pdfPageEnd: row.pdf_page_end,
    markdownPath: workspaceDataPath(workspace, join(row.paper_relative_dir, 'paper.md')),
    lineStart: row.line_start,
    lineEnd: row.line_end,
    content,
    caption: row.caption,
  }
}

export function elementSearchText(row: PaperElementRow): string {
  return [row.element_type, row.section, row.caption ?? '', row.content].filter(Boolean).join('\n')
}

export function ftsQueryFor(query: string): string {
  const terms: string[] = []
  for (const match of query.matchAll(/[\u3400-\u9fff]+|[\p{L}\p{N}_-]+/gu)) {
    const term = match[0] ?? ''
    if (/^[\u3400-\u9fff]+$/.test(term) && term.length > 1) {
      for (let index = 0; index < term.length - 1; index += 1) terms.push(term.slice(index, index + 2))
    } else if (term.length >= 2) terms.push(term)
  }
  return [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

function relevanceScore(content: string, wholeQuery: string, tokens: readonly string[]): number {
  const haystack = content.toLocaleLowerCase()
  let score = countOccurrences(haystack, wholeQuery) * 8
  for (const token of tokens) score += countOccurrences(haystack, token)
  return score
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let position = 0
  while (true) {
    const found = haystack.indexOf(needle, position)
    if (found === -1) return count
    count += 1
    position = found + needle.length
  }
}

function normalizedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(id => id !== ''))].slice(0, 100)
}

interface PaperChunkCitationRow {
  readonly paper_title: string
  readonly paper_authors: string
  readonly paper_year: number | null
  readonly paper_relative_dir: string
}

interface PaperElementCitationRow {
  readonly paper_title: string
  readonly paper_relative_dir: string
}
