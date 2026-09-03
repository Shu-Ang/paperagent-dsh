import type { DatabaseSync } from 'node:sqlite'
import type { PaperBibliographyEntry, PaperRecord } from '../models.ts'
import type { PaperRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'
import { toPaperRecord } from '../row-mappers.ts'
import { isValidBibtexEntry, parseBibtexMetadata } from '../bibtex.ts'

export function readPaperBibliography(db: DatabaseSync, workspacePath: string, paperIds: readonly string[]): PaperBibliographyEntry[] {
  const workspace = canonicalWorkspace(workspacePath)
  const uniquePaperIds = [...new Set(paperIds.map(id => id.trim()).filter(Boolean))]
  if (uniquePaperIds.length === 0) throw new Error('at least one paper id is required')
  if (uniquePaperIds.length > 20) throw new Error('at most 20 paper ids can be read at once')

  return uniquePaperIds.map(paperId => {
    const paper = getPaper(db, workspace, paperId)
    const bibtex = paper.bibtex
    const parsed = bibtex === null ? null : parseBibtexMetadata(bibtex)
    const hasValidEntry = bibtex !== null && isValidBibtexEntry(bibtex)
    const citationKey = paper.citationKey ?? parsed?.citationKey ?? null
    const metadataStatus = bibtex === null
      ? 'missing-bibtex'
      : !hasValidEntry
        ? 'invalid-bibtex'
        : citationKey === null
          ? 'missing-citation-key'
          : 'ready'
    return {
      paperId: paper.id,
      title: paper.title,
      citationKey,
      bibtex,
      doi: paper.doi,
      sourceAdapter: paper.sourceAdapter,
      metadataStatus,
    }
  })
}

/** Persists one fully materialized paper record. Callers own transaction/file orchestration. */
export function insertPaper(db: DatabaseSync, paper: PaperRecord): void {
  db.prepare(`
    INSERT INTO papers (
      id, workspace_path, library_id, title, authors, year, doi, bibtex, citation_key, journal, volume, issue, pages, url, abstract, keywords, pdf_source_url, bibtex_source_url, source_adapter, metadata_provenance_json,
      file_hash, relative_dir, original_file_name, parse_status, parse_error, parser_version, parse_revision, parsed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    paper.id, paper.workspacePath, paper.libraryId, paper.title, JSON.stringify(paper.authors), paper.year,
    paper.doi, paper.bibtex, paper.citationKey, paper.journal, paper.volume, paper.issue, paper.pages, paper.url, paper.abstract, paper.keywords,
    paper.pdfSourceUrl, paper.bibtexSourceUrl, paper.sourceAdapter, JSON.stringify(paper.metadataProvenance),
    paper.fileHash, paper.relativeDir, paper.originalFileName, paper.parseStatus, paper.parseError, paper.parserVersion, paper.parseRevision, paper.parsedAt,
    paper.createdAt, paper.updatedAt,
  )
}

export function listPapers(db: DatabaseSync, workspacePath: string, libraryId?: string | null): PaperRecord[] {
  const workspace = canonicalWorkspace(workspacePath)
  const rows = libraryId === undefined
    ? db.prepare('SELECT * FROM papers WHERE workspace_path = ? ORDER BY updated_at DESC').all(workspace)
    : libraryId === null
      ? db.prepare('SELECT * FROM papers WHERE workspace_path = ? AND library_id IS NULL ORDER BY updated_at DESC').all(workspace)
      : db.prepare('SELECT * FROM papers WHERE workspace_path = ? AND library_id = ? ORDER BY updated_at DESC').all(workspace, libraryId)
  return (rows as unknown as PaperRow[]).map(toPaperRecord)
}

export function getPaper(db: DatabaseSync, workspacePath: string, paperId: string): PaperRecord {
  const row = db.prepare('SELECT * FROM papers WHERE workspace_path = ? AND id = ?').get(canonicalWorkspace(workspacePath), paperId) as PaperRow | undefined
  if (row === undefined) throw new Error('paper not found in the active workspace')
  return toPaperRecord(row)
}
