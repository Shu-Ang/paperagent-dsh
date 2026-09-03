import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CreateLibraryInput } from '../inputs.ts'
import type { LibraryRecord } from '../models.ts'
import type { LibraryRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'
import { requireNonBlank } from '../validation.ts'
import { toLibraryRecord } from '../row-mappers.ts'

export function createLibrary(db: DatabaseSync, input: CreateLibraryInput): LibraryRecord {
  const workspacePath = canonicalWorkspace(input.workspacePath)
  const name = requireNonBlank(input.name, 'library name')
  const now = new Date().toISOString()
  const record: LibraryRecord = { id: randomUUID(), workspacePath, name, paperCount: 0, createdAt: now, updatedAt: now }
  db.prepare('INSERT INTO libraries (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(record.id, record.workspacePath, record.name, record.createdAt, record.updatedAt)
  return record
}

export function listLibraries(db: DatabaseSync, workspacePath: string): LibraryRecord[] {
  const rows = db.prepare(`
    SELECT l.id, l.workspace_path, l.name, l.created_at, l.updated_at, COUNT(p.id) AS paper_count
    FROM libraries l LEFT JOIN papers p ON p.library_id = l.id AND p.workspace_path = l.workspace_path
    WHERE l.workspace_path = ?
    GROUP BY l.id, l.workspace_path, l.name, l.created_at, l.updated_at
    ORDER BY l.created_at ASC
  `).all(canonicalWorkspace(workspacePath)) as unknown as LibraryRow[]
  return rows.map(toLibraryRecord)
}

export function assertLibrary(db: DatabaseSync, workspacePath: string, libraryId: string): void {
  const workspace = canonicalWorkspace(workspacePath)
  const row = db.prepare('SELECT id FROM libraries WHERE workspace_path = ? AND id = ?').get(workspace, libraryId)
  if (row === undefined) throw new Error('library not found in the active workspace')
}

export function deleteLibrary(db: DatabaseSync, workspacePath: string, libraryId: string): void {
  const workspace = canonicalWorkspace(workspacePath)
  assertLibrary(db, workspace, libraryId)
  const now = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE papers SET library_id = NULL, updated_at = ? WHERE workspace_path = ? AND library_id = ?').run(now, workspace, libraryId)
    db.prepare('DELETE FROM libraries WHERE workspace_path = ? AND id = ?').run(workspace, libraryId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function renameLibrary(db: DatabaseSync, workspacePath: string, libraryId: string, name: string): LibraryRecord {
  const workspace = canonicalWorkspace(workspacePath)
  assertLibrary(db, workspace, libraryId)
  const normalizedName = requireNonBlank(name, 'library name')
  db.prepare('UPDATE libraries SET name = ?, updated_at = ? WHERE workspace_path = ? AND id = ?').run(normalizedName, new Date().toISOString(), workspace, libraryId)
  const library = listLibraries(db, workspace).find(item => item.id === libraryId)
  if (library === undefined) throw new Error('library not found after rename')
  return library
}
