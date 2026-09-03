import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CreatePaperFigureInput } from '../inputs.ts'
import type { FigureVisionStatus, PaperFigureRecord, PaperRecord } from '../models.ts'
import type { PaperFigureRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'
import { nullableText, safeFigureRelativePath } from '../normalizers.ts'
import { requireNonBlank } from '../validation.ts'
import { figureFtsText } from '../figure-text.ts'
import { toPaperFigureRecord } from '../row-mappers.ts'

type PaperGetter = (workspacePath: string, paperId: string) => PaperRecord

export function replacePaperFigures(
  db: DatabaseSync,
  fts5Enabled: boolean,
  getPaper: PaperGetter,
  workspacePath: string,
  paperId: string,
  figures: readonly CreatePaperFigureInput[],
  manageTransaction = true,
): PaperFigureRecord[] {
  const paper = getPaper(workspacePath, paperId)
  const workspace = paper.workspacePath
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO paper_figures (
      id, paper_id, workspace_path, element_id, figure_label, page_number, section_title, relative_path, mime_type, sha256,
      raw_caption, nearby_text, vision_description, vision_status, vision_model, vision_prompt_version, vision_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, NULL, NULL, ?, ?)
  `)
  const insertFts = fts5Enabled
    ? db.prepare('INSERT INTO paper_figures_fts (figure_id, paper_id, workspace_path, content) VALUES (?, ?, ?, ?)')
    : undefined
  if (manageTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    if (fts5Enabled) db.prepare('DELETE FROM paper_figures_fts WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    db.prepare('DELETE FROM paper_figures WHERE workspace_path = ? AND paper_id = ?').run(workspace, paperId)
    for (const source of figures) {
      if (source.paperId !== paperId || canonicalWorkspace(source.workspacePath) !== workspace) throw new Error('paper figure belongs to a different workspace or paper')
      if (!Number.isInteger(source.pageNumber) || source.pageNumber < 1) throw new Error('figure page number must be positive')
      const record: PaperFigureRecord = {
        id: source.id ?? randomUUID(), paperId, workspacePath: workspace, elementId: source.elementId ?? null, figureLabel: nullableText(source.figureLabel ?? null), pageNumber: source.pageNumber,
        sectionTitle: requireNonBlank(source.sectionTitle, 'figure section'), relativePath: safeFigureRelativePath(source.relativePath),
        mimeType: requireNonBlank(source.mimeType, 'figure MIME type'), sha256: requireNonBlank(source.sha256, 'figure SHA-256'),
        rawCaption: source.rawCaption.trim(), nearbyText: source.nearbyText.trim(), visionDescription: null, visionStatus: 'queued',
        visionModel: null, visionPromptVersion: null, visionError: null, createdAt: now, updatedAt: now,
      }
      insert.run(record.id, record.paperId, record.workspacePath, record.elementId, record.figureLabel, record.pageNumber, record.sectionTitle, record.relativePath, record.mimeType, record.sha256, record.rawCaption, record.nearbyText, now, now)
      insertFts?.run(record.id, record.paperId, workspace, ftsIndexedText(figureFtsText(record)))
      if (fts5Enabled && record.elementId !== null) {
        db.prepare('UPDATE paper_elements_fts SET content = ?, caption = ?, section = ? WHERE element_id = ?')
          .run(ftsIndexedText([record.rawCaption, record.nearbyText].filter(Boolean).join('\n')), record.rawCaption, record.sectionTitle, record.elementId)
      }
    }
    if (manageTransaction) db.exec('COMMIT')
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK')
    throw error
  }
  return listPaperFigures(db, getPaper, workspace, paperId)
}

export function listPaperFigures(db: DatabaseSync, getPaper: PaperGetter, workspacePath: string, paperId: string): PaperFigureRecord[] {
  const paper = getPaper(workspacePath, paperId)
  const rows = db.prepare('SELECT * FROM paper_figures WHERE workspace_path = ? AND paper_id = ? ORDER BY page_number ASC, created_at ASC')
    .all(paper.workspacePath, paper.id) as unknown as PaperFigureRow[]
  return rows.map(toPaperFigureRecord)
}

export function getPaperFigure(db: DatabaseSync, workspacePath: string, figureId: string): PaperFigureRecord {
  const row = db.prepare('SELECT * FROM paper_figures WHERE workspace_path = ? AND id = ?')
    .get(canonicalWorkspace(workspacePath), figureId) as PaperFigureRow | undefined
  if (row === undefined) throw new Error('paper figure not found in the active workspace')
  return toPaperFigureRecord(row)
}

export function setPaperFigureVisionStatus(
  db: DatabaseSync,
  fts5Enabled: boolean,
  workspacePath: string,
  figureId: string,
  status: FigureVisionStatus,
  details: { readonly description?: string; readonly model?: string; readonly promptVersion?: string; readonly error?: string } = {},
): PaperFigureRecord {
  const existing = getPaperFigure(db, workspacePath, figureId)
  const now = new Date().toISOString()
  const description = status === 'ready' ? requireNonBlank(details.description ?? '', 'vision description') : existing.visionDescription
  const error = status === 'failed' ? requireNonBlank(details.error ?? 'unknown vision failure', 'vision error') : null
  if (fts5Enabled) db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE paper_figures SET vision_description = ?, vision_status = ?, vision_model = ?, vision_prompt_version = ?, vision_error = ?, updated_at = ?
      WHERE workspace_path = ? AND id = ?
    `).run(description, status, details.model ?? existing.visionModel, details.promptVersion ?? existing.visionPromptVersion, error, now, existing.workspacePath, existing.id)
    const updated = getPaperFigure(db, existing.workspacePath, existing.id)
    if (fts5Enabled) {
      db.prepare('DELETE FROM paper_figures_fts WHERE figure_id = ?').run(updated.id)
      db.prepare('INSERT INTO paper_figures_fts (figure_id, paper_id, workspace_path, content) VALUES (?, ?, ?, ?)')
        .run(updated.id, updated.paperId, updated.workspacePath, ftsIndexedText(figureFtsText(updated)))
      if (updated.elementId !== null) {
        db.prepare('UPDATE paper_elements_fts SET content = ?, caption = ?, section = ? WHERE element_id = ?')
          .run(ftsIndexedText([updated.rawCaption, updated.nearbyText, updated.visionDescription ?? ''].filter(Boolean).join('\n')), updated.rawCaption, updated.sectionTitle, updated.elementId)
      }
    }
    if (fts5Enabled) db.exec('COMMIT')
    return updated
  } catch (error) {
    if (fts5Enabled) db.exec('ROLLBACK')
    throw error
  }
}

export function findReusableFigureVision(db: DatabaseSync, workspacePath: string, sha256: string, excludeFigureId?: string): PaperFigureRecord | undefined {
  const workspace = canonicalWorkspace(workspacePath)
  const row = db.prepare(`
    SELECT * FROM paper_figures
    WHERE workspace_path = ? AND sha256 = ? AND vision_status = 'ready' AND vision_description IS NOT NULL
      AND (? IS NULL OR id <> ?)
    ORDER BY updated_at DESC LIMIT 1
  `).get(workspace, requireNonBlank(sha256, 'figure SHA-256'), excludeFigureId ?? null, excludeFigureId ?? null) as PaperFigureRow | undefined
  return row === undefined ? undefined : toPaperFigureRecord(row)
}

function ftsIndexedText(content: string): string {
  const cjkBigrams: string[] = []
  for (const segment of content.matchAll(/[\u3400-\u9fff]+/g)) {
    const text = segment[0] ?? ''
    for (let index = 0; index < text.length - 1; index += 1) cjkBigrams.push(text.slice(index, index + 2))
  }
  return cjkBigrams.length === 0 ? content : `${content}\n${cjkBigrams.join(' ')}`
}
