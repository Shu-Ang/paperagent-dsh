import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ParseJobRecord, ParseJobStatus, ParseStatus, PaperRecord } from '../models.ts'
import type { ParseJobRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'
import { toParseJobRecord } from '../row-mappers.ts'

export function findActiveParseJob(db: DatabaseSync, workspacePath: string, paperId: string): ParseJobRecord | undefined {
  const row = db.prepare(`
    SELECT * FROM paper_parse_jobs
    WHERE workspace_path = ? AND paper_id = ? AND status IN ('queued', 'parsing')
    ORDER BY created_at DESC LIMIT 1
  `).get(canonicalWorkspace(workspacePath), paperId) as ParseJobRow | undefined
  return row === undefined ? undefined : toParseJobRecord(row)
}

export function createParseJob(
  db: DatabaseSync,
  paper: PaperRecord,
  setParseStatus: (workspacePath: string, paperId: string, status: ParseStatus) => void,
  id = randomUUID(),
): ParseJobRecord {
  const active = findActiveParseJob(db, paper.workspacePath, paper.id)
  if (active !== undefined) return active
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO paper_parse_jobs (
      id, workspace_path, paper_id, status, current_page, total_pages, chunk_count, error, created_at, started_at, finished_at
    ) VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, NULL, NULL)
  `).run(id, paper.workspacePath, paper.id, now)
  setParseStatus(paper.workspacePath, paper.id, 'queued')
  return getParseJob(db, paper.workspacePath, id)
}

export function getParseJob(db: DatabaseSync, workspacePath: string, jobId: string): ParseJobRecord {
  const row = db.prepare('SELECT * FROM paper_parse_jobs WHERE workspace_path = ? AND id = ?')
    .get(canonicalWorkspace(workspacePath), jobId) as ParseJobRow | undefined
  if (row === undefined) throw new Error('parse job not found in the active workspace')
  return toParseJobRecord(row)
}

export function updateParseJob(db: DatabaseSync, workspacePath: string, jobId: string, patch: {
  readonly status?: ParseJobStatus
  readonly currentPage?: number | null
  readonly totalPages?: number | null
  readonly chunkCount?: number | null
  readonly error?: string | null
  readonly startedAt?: string | null
  readonly finishedAt?: string | null
}): ParseJobRecord {
  const current = getParseJob(db, workspacePath, jobId)
  const next = { ...current, ...patch }
  db.prepare(`
    UPDATE paper_parse_jobs SET status = ?, current_page = ?, total_pages = ?, chunk_count = ?, error = ?, started_at = ?, finished_at = ?
    WHERE workspace_path = ? AND id = ?
  `).run(next.status, next.currentPage, next.totalPages, next.chunkCount, next.error, next.startedAt, next.finishedAt, current.workspacePath, current.id)
  return getParseJob(db, current.workspacePath, current.id)
}

export function recoverParseJobs(
  db: DatabaseSync,
  setParseStatus: (workspacePath: string, paperId: string, status: ParseStatus) => void,
): ParseJobRecord[] {
  const rows = db.prepare("SELECT * FROM paper_parse_jobs WHERE status IN ('queued', 'parsing') ORDER BY created_at ASC").all() as unknown as ParseJobRow[]
  for (const row of rows) {
    db.prepare("UPDATE paper_parse_jobs SET status = 'queued', current_page = NULL, total_pages = NULL, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?")
      .run(row.id)
    setParseStatus(row.workspace_path, row.paper_id, 'queued')
  }
  return rows.map(row => getParseJob(db, row.workspace_path, row.id))
}
