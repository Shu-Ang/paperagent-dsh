import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { buildEmbeddingSources } from '../embedding-projection.ts'
import type { EmbeddingJobRecord, EmbeddingJobStatus, PaperChunkRecord, PaperElementRecord, PaperEmbeddingSource, PaperFigureRecord, PaperRecord } from '../models.ts'
import { toEmbeddingJobRecord, toPaperFigureRecord } from '../row-mappers.ts'
import type { EmbeddingJobRow, PaperChunkRow, PaperElementRow, PaperFigureRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'

export function createEmbeddingJob(
  db: DatabaseSync,
  paper: PaperRecord,
  input: { readonly provider: string; readonly model: string; readonly dimensions: number; readonly totalItems: number },
): EmbeddingJobRecord {
  assertIndexablePaper(paper)
  const existing = db.prepare(`SELECT * FROM paper_embedding_jobs
    WHERE workspace_path = ? AND paper_id = ? AND parse_revision = ? AND provider = ? AND model = ? AND dimensions = ?`)
    .get(paper.workspacePath, paper.id, paper.parseRevision, input.provider, input.model, input.dimensions) as EmbeddingJobRow | undefined
  if (existing !== undefined) return toEmbeddingJobRecord(existing)
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(`INSERT INTO paper_embedding_jobs (
    id, workspace_path, paper_id, parse_revision, provider, model, dimensions, status,
    total_items, completed_items, error, retry_count, created_at, started_at, finished_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, 0, ?, NULL, NULL, ?)`)
    .run(id, paper.workspacePath, paper.id, paper.parseRevision, input.provider, input.model, input.dimensions, input.totalItems, now, now)
  return getEmbeddingJob(db, paper.workspacePath, id)
}

/** Requeues an already indexed revision, or creates its first derived-index job. */
export function restartEmbeddingJob(
  db: DatabaseSync,
  paper: PaperRecord,
  input: { readonly provider: string; readonly model: string; readonly dimensions: number; readonly totalItems: number },
): EmbeddingJobRecord {
  assertIndexablePaper(paper)
  const existing = db.prepare(`SELECT * FROM paper_embedding_jobs
    WHERE workspace_path = ? AND paper_id = ? AND parse_revision = ? AND provider = ? AND model = ? AND dimensions = ?`)
    .get(paper.workspacePath, paper.id, paper.parseRevision, input.provider, input.model, input.dimensions) as EmbeddingJobRow | undefined
  if (existing === undefined) return createEmbeddingJob(db, paper, input)
  if (existing.status === 'queued' || existing.status === 'processing') return toEmbeddingJobRecord(existing)
  const now = new Date().toISOString()
  db.prepare(`UPDATE paper_embedding_jobs SET status = 'queued', total_items = ?, completed_items = 0, error = NULL,
    retry_count = 0, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`)
    .run(input.totalItems, now, existing.id)
  return getEmbeddingJob(db, paper.workspacePath, existing.id)
}

export function getEmbeddingJob(db: DatabaseSync, workspacePath: string, jobId: string): EmbeddingJobRecord {
  const row = db.prepare('SELECT * FROM paper_embedding_jobs WHERE workspace_path = ? AND id = ?')
    .get(canonicalWorkspace(workspacePath), jobId) as EmbeddingJobRow | undefined
  if (row === undefined) throw new Error('embedding job not found in the active workspace')
  return toEmbeddingJobRecord(row)
}

export function updateEmbeddingJob(db: DatabaseSync, workspacePath: string, jobId: string, patch: {
  readonly status?: EmbeddingJobStatus; readonly completedItems?: number; readonly error?: string | null
  readonly retryCount?: number; readonly startedAt?: string | null; readonly finishedAt?: string | null
}): EmbeddingJobRecord {
  const current = getEmbeddingJob(db, workspacePath, jobId)
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  db.prepare(`UPDATE paper_embedding_jobs SET status = ?, completed_items = ?, error = ?, retry_count = ?,
    started_at = ?, finished_at = ?, updated_at = ? WHERE workspace_path = ? AND id = ?`)
    .run(next.status, next.completedItems, next.error, next.retryCount, next.startedAt, next.finishedAt, next.updatedAt, current.workspacePath, current.id)
  return getEmbeddingJob(db, current.workspacePath, current.id)
}

/** Requeue recoverable derived-index work. Parse state stays ready and unaffected. */
export function recoverEmbeddingJobs(db: DatabaseSync): EmbeddingJobRecord[] {
  const rows = db.prepare("SELECT * FROM paper_embedding_jobs WHERE status IN ('queued', 'processing') ORDER BY created_at ASC").all() as unknown as EmbeddingJobRow[]
  const now = new Date().toISOString()
  for (const row of rows) db.prepare("UPDATE paper_embedding_jobs SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id)
  return rows.map(row => getEmbeddingJob(db, row.workspace_path, row.id))
}

/** Reads only current SQLite facts and rebuilds the provider projection on demand. */
export function listEmbeddingSources(db: DatabaseSync, paper: PaperRecord): PaperEmbeddingSource[] {
  const chunks = db.prepare('SELECT * FROM paper_chunks WHERE workspace_path = ? AND paper_id = ? ORDER BY line_start ASC')
    .all(paper.workspacePath, paper.id) as unknown as PaperChunkRow[]
  const elements = db.prepare('SELECT * FROM paper_elements WHERE workspace_path = ? AND paper_id = ? ORDER BY reading_order ASC')
    .all(paper.workspacePath, paper.id) as unknown as PaperElementRow[]
  const figures = db.prepare('SELECT * FROM paper_figures WHERE workspace_path = ? AND paper_id = ?')
    .all(paper.workspacePath, paper.id) as unknown as PaperFigureRow[]
  const links = db.prepare(`SELECT ce.element_id, ce.chunk_id FROM paper_chunk_elements ce
    JOIN paper_chunks c ON c.id = ce.chunk_id WHERE c.workspace_path = ? AND c.paper_id = ?`).all(paper.workspacePath, paper.id) as unknown as Array<{ element_id: string; chunk_id: string }>
  const linkedChunkIdsByElement = new Map<string, string[]>()
  for (const link of links) linkedChunkIdsByElement.set(link.element_id, [...(linkedChunkIdsByElement.get(link.element_id) ?? []), link.chunk_id])
  return buildEmbeddingSources({
    paper,
    chunks: chunks.map(toChunk), elements: elements.map(toElement), figures: figures.map(toPaperFigureRecord), linkedChunkIdsByElement,
  })
}

function toChunk(row: PaperChunkRow): PaperChunkRecord {
  // The domain contract intentionally exposes only searchable child chunks.
  // Normalize legacy/null rows at the repository boundary rather than using a
  // conditional expression whose both branches had the same value.
  return { id: row.id, paperId: row.paper_id, workspacePath: row.workspace_path, section: row.section, ...(row.section_id === null ? {} : { sectionId: row.section_id }), parentSectionId: row.parent_section_id, chunkType: 'child', sequence: row.sequence ?? 0, pdfPageStart: row.pdf_page_start, pdfPageEnd: row.pdf_page_end, lineStart: row.line_start, lineEnd: row.line_end, content: row.content, createdAt: row.created_at }
}

function toElement(row: PaperElementRow): PaperElementRecord {
  return { id: row.id, paperId: row.paper_id, workspacePath: row.workspace_path, elementType: row.element_type, section: row.section, ...(row.section_id === null ? {} : { sectionId: row.section_id }), parentSectionId: row.parent_section_id,
    pdfPageStart: row.pdf_page_start, pdfPageEnd: row.pdf_page_end, lineStart: row.line_start, lineEnd: row.line_end, readingOrder: row.reading_order,
    content: row.content, caption: row.caption, contentFormat: row.content_format, createdAt: row.created_at, updatedAt: row.updated_at }
}

function assertIndexablePaper(paper: PaperRecord): void {
  if (paper.parseRevision === null || paper.parseRevision.startsWith('legacy-') || paper.parseStatus !== 'ready') {
    throw new Error('only a ready paper with an immutable parse revision can be indexed; reparse legacy papers first')
  }
}
