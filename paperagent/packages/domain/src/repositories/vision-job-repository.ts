import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { VisionJobRecord, VisionJobStatus, FigureVisionStatus, PaperFigureRecord } from '../models.ts'
import type { VisionJobRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'
import { toVisionJobRecord } from '../row-mappers.ts'

export function findActiveVisionJob(db: DatabaseSync, workspacePath: string, figureId: string): VisionJobRecord | undefined {
  const row = db.prepare(`
    SELECT * FROM paper_vision_jobs
    WHERE workspace_path = ? AND figure_id = ? AND status IN ('queued', 'processing')
    ORDER BY created_at DESC LIMIT 1
  `).get(canonicalWorkspace(workspacePath), figureId) as VisionJobRow | undefined
  return row === undefined ? undefined : toVisionJobRecord(row)
}

export function createVisionJob(db: DatabaseSync, figure: PaperFigureRecord, id = randomUUID()): VisionJobRecord {
  const active = findActiveVisionJob(db, figure.workspacePath, figure.id)
  if (active !== undefined) return active
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO paper_vision_jobs (id, workspace_path, figure_id, status, error, created_at, started_at, finished_at)
    VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL)
  `).run(id, figure.workspacePath, figure.id, now)
  return getVisionJob(db, figure.workspacePath, id)
}

export function getVisionJob(db: DatabaseSync, workspacePath: string, jobId: string): VisionJobRecord {
  const row = db.prepare('SELECT * FROM paper_vision_jobs WHERE workspace_path = ? AND id = ?')
    .get(canonicalWorkspace(workspacePath), jobId) as VisionJobRow | undefined
  if (row === undefined) throw new Error('vision job not found in the active workspace')
  return toVisionJobRecord(row)
}

export function updateVisionJob(db: DatabaseSync, workspacePath: string, jobId: string, patch: {
  readonly status?: VisionJobStatus
  readonly error?: string | null
  readonly startedAt?: string | null
  readonly finishedAt?: string | null
}): VisionJobRecord {
  const current = getVisionJob(db, workspacePath, jobId)
  const next = { ...current, ...patch }
  db.prepare(`
    UPDATE paper_vision_jobs SET status = ?, error = ?, started_at = ?, finished_at = ?
    WHERE workspace_path = ? AND id = ?
  `).run(next.status, next.error, next.startedAt, next.finishedAt, current.workspacePath, current.id)
  return getVisionJob(db, current.workspacePath, current.id)
}

export function recoverVisionJobs(
  db: DatabaseSync,
  setFigureVisionStatus: (workspacePath: string, figureId: string, status: FigureVisionStatus) => void,
): VisionJobRecord[] {
  const rows = db.prepare("SELECT * FROM paper_vision_jobs WHERE status IN ('queued', 'processing') ORDER BY created_at ASC").all() as unknown as VisionJobRow[]
  for (const row of rows) {
    db.prepare("UPDATE paper_vision_jobs SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?").run(row.id)
    setFigureVisionStatus(row.workspace_path, row.figure_id, 'queued')
  }
  return rows.map(row => getVisionJob(db, row.workspace_path, row.id))
}
