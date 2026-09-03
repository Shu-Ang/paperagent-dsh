import type { DatabaseSync } from 'node:sqlite'
import type { PaperReferenceRecord, PaperRecord } from '../models.ts'
import type { PaperReferenceRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'

type PaperGetter = (workspacePath: string, paperId: string) => PaperRecord

export function replacePaperReferences(
  db: DatabaseSync,
  getPaper: PaperGetter,
  workspacePath: string,
  paperId: string,
  references: readonly PaperReferenceRecord[],
  manageTransaction = true,
): void {
  const paper = getPaper(workspacePath, paperId)
  const workspace = paper.workspacePath
  const insert = db.prepare(`
    INSERT INTO paper_references (
      id, paper_id, workspace_path, ordinal, label, raw_text, authors_json, title, year,
      venue, doi, url, section, pdf_page_start, pdf_page_end, line_start, line_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  if (manageTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM paper_references WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    for (const reference of references) {
      if (reference.paperId !== paperId || canonicalWorkspace(reference.workspacePath) !== workspace) throw new Error('paper reference belongs to a different workspace or paper')
      if (reference.rawText.trim() === '') throw new Error('paper reference raw text must not be blank')
      insert.run(
        reference.id, reference.paperId, workspace, reference.ordinal, reference.label, reference.rawText,
        JSON.stringify(reference.authors), reference.title, reference.year, reference.venue, reference.doi, reference.url,
        reference.section, reference.pdfPageStart, reference.pdfPageEnd, reference.lineStart, reference.lineEnd,
        reference.createdAt, reference.updatedAt,
      )
    }
    if (manageTransaction) db.exec('COMMIT')
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK')
    throw error
  }
}

export function listPaperReferences(db: DatabaseSync, getPaper: PaperGetter, workspacePath: string, paperId: string): PaperReferenceRecord[] {
  const paper = getPaper(workspacePath, paperId)
  const rows = db.prepare(`
    SELECT * FROM paper_references
    WHERE workspace_path = ? AND paper_id = ?
    ORDER BY ordinal ASC, id ASC
  `).all(paper.workspacePath, paper.id) as unknown as PaperReferenceRow[]
  return rows.map(toPaperReference)
}

export function getPaperReference(db: DatabaseSync, getPaper: PaperGetter, workspacePath: string, paperId: string, ordinal: number): PaperReferenceRecord {
  const paper = getPaper(workspacePath, paperId)
  const row = db.prepare(`
    SELECT * FROM paper_references
    WHERE workspace_path = ? AND paper_id = ? AND ordinal = ?
    ORDER BY id ASC LIMIT 1
  `).get(paper.workspacePath, paper.id, ordinal) as PaperReferenceRow | undefined
  if (row === undefined) throw new Error(`reference ${ordinal} was not found in paper ${paper.id}`)
  return toPaperReference(row)
}

function toPaperReference(row: PaperReferenceRow): PaperReferenceRecord {
  let authors: readonly string[] = []
  try {
    const parsed: unknown = JSON.parse(row.authors_json)
    if (Array.isArray(parsed)) authors = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    authors = []
  }
  return {
    id: row.id, paperId: row.paper_id, workspacePath: row.workspace_path, ordinal: row.ordinal, label: row.label,
    rawText: row.raw_text, authors, title: row.title, year: row.year, venue: row.venue, doi: row.doi, url: row.url,
    section: row.section, pdfPageStart: row.pdf_page_start, pdfPageEnd: row.pdf_page_end,
    lineStart: row.line_start, lineEnd: row.line_end, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
