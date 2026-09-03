import type { DatabaseSync } from 'node:sqlite'
import type { PaperChunkRecord, PaperElementRecord, PaperRecord, PaperSectionRecord } from '../models.ts'
import { canonicalWorkspace } from '../paths.ts'

type PaperGetter = (workspacePath: string, paperId: string) => PaperRecord

/** Replaces chunk/element rows and their FTS projections in one transaction. */
export function replacePaperChunks(
  db: DatabaseSync,
  fts5Enabled: boolean,
  getPaper: PaperGetter,
  workspacePath: string,
  paperId: string,
  chunks: readonly PaperChunkRecord[],
  elements: readonly PaperElementRecord[] = [],
  manageTransaction = true,
  sections: readonly PaperSectionRecord[] = [],
): void {
  const paper = getPaper(workspacePath, paperId)
  const workspace = paper.workspacePath
  const insert = db.prepare(`
    INSERT INTO paper_chunks (
      id, paper_id, workspace_path, section, section_id, parent_section_id, chunk_type, sequence,
      pdf_page_start, pdf_page_end, line_start, line_end, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSection = db.prepare(`
    INSERT INTO paper_sections (
      id, paper_id, workspace_path, title, level, parent_id, path,
      pdf_page_start, pdf_page_end, line_start, line_end, reading_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = fts5Enabled
    ? db.prepare('INSERT INTO paper_chunks_fts (chunk_id, paper_id, workspace_path, content) VALUES (?, ?, ?, ?)')
    : undefined
  const insertElement = db.prepare(`
    INSERT INTO paper_elements (
      id, paper_id, workspace_path, element_type, section, section_id, parent_section_id, pdf_page_start, pdf_page_end,
      line_start, line_end, reading_order, content, caption, content_format, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertElementFts = fts5Enabled
    ? db.prepare('INSERT INTO paper_elements_fts (element_id, paper_id, workspace_path, element_type, content, caption, section) VALUES (?, ?, ?, ?, ?, ?, ?)')
    : undefined
  const insertChunkElement = db.prepare('INSERT INTO paper_chunk_elements (chunk_id, element_id) VALUES (?, ?)')
  if (manageTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    if (fts5Enabled) {
      db.prepare('DELETE FROM paper_chunks_fts WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
      db.prepare('DELETE FROM paper_elements_fts WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    }
    db.prepare('DELETE FROM paper_chunks WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    db.prepare('DELETE FROM paper_sections WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    db.prepare('DELETE FROM paper_elements WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    for (const section of sections) {
      if (section.paperId !== paperId || canonicalWorkspace(section.workspacePath) !== workspace) throw new Error('paper section belongs to a different workspace or paper')
      insertSection.run(section.id, section.paperId, workspace, nonBlank(section.title, 'section title'), section.level, section.parentId, nonBlank(section.path, 'section path'), section.pdfPageStart, section.pdfPageEnd, section.lineStart, section.lineEnd, section.readingOrder, section.createdAt)
    }
    for (const chunk of chunks) {
      if (chunk.paperId !== paperId || canonicalWorkspace(chunk.workspacePath) !== workspace) throw new Error('paper chunk belongs to a different workspace or paper')
      if (chunk.content.trim() === '') throw new Error('paper chunk content must not be blank')
      insert.run(chunk.id, chunk.paperId, workspace, nonBlank(chunk.section, 'chunk section'), chunk.sectionId ?? null, chunk.parentSectionId ?? null, chunk.chunkType ?? 'child', chunk.sequence ?? 0, chunk.pdfPageStart, chunk.pdfPageEnd, chunk.lineStart, chunk.lineEnd, chunk.content, chunk.createdAt)
      insertFts?.run(chunk.id, chunk.paperId, workspace, ftsIndexedText(chunk.content))
    }
    for (const element of elements) {
      if (element.paperId !== paperId || canonicalWorkspace(element.workspacePath) !== workspace) throw new Error('paper element belongs to a different workspace or paper')
      if (element.content.trim() === '') throw new Error('paper element content must not be blank')
      insertElement.run(element.id, element.paperId, workspace, element.elementType, nonBlank(element.section, 'element section'), element.sectionId ?? null, element.parentSectionId ?? null, element.pdfPageStart, element.pdfPageEnd, element.lineStart, element.lineEnd, element.readingOrder, element.content, element.caption, element.contentFormat, element.createdAt, element.updatedAt)
      insertElementFts?.run(element.id, element.paperId, workspace, element.elementType, ftsIndexedText(element.content), element.caption ?? '', element.section)
    }
    const elementIds = new Set(elements.map(element => element.id))
    for (const chunk of chunks) for (const elementId of chunk.elementIds ?? []) {
      if (!elementIds.has(elementId)) throw new Error('paper chunk references an unknown element')
      insertChunkElement.run(chunk.id, elementId)
    }
    if (manageTransaction) db.exec('COMMIT')
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function nonBlank(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${field} must not be blank`)
  return normalized
}

function ftsIndexedText(content: string): string {
  const cjkBigrams: string[] = []
  for (const segment of content.matchAll(/[\u3400-\u9fff]+/g)) {
    const text = segment[0] ?? ''
    for (let index = 0; index < text.length - 1; index += 1) cjkBigrams.push(text.slice(index, index + 2))
  }
  return cjkBigrams.length === 0 ? content : `${content}\n${cjkBigrams.join(' ')}`
}
