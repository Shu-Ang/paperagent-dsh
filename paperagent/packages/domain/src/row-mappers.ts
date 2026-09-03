import { join } from 'node:path'
import type { EmbeddingJobRecord, LibraryRecord, PaperFigureCitation, PaperFigureRecord, PaperRecord, ParseJobRecord, VisionJobRecord } from './models.ts'
import type { EmbeddingJobRow, PaperFigureRow, PaperRow, LibraryRow, ParseJobRow, VisionJobRow } from './rows.ts'
import { parseStringArray } from './validation.ts'
import { workspaceDataPath } from './paths.ts'

export function toLibraryRecord(row: LibraryRow): LibraryRecord {
  return { id: row.id, workspacePath: row.workspace_path, name: row.name, paperCount: row.paper_count, createdAt: row.created_at, updatedAt: row.updated_at }
}

export function toPaperRecord(row: PaperRow): PaperRecord {
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    libraryId: row.library_id,
    title: row.title,
    authors: parseStringArray(row.authors, 'paper authors'),
    year: row.year,
    doi: row.doi,
    bibtex: row.bibtex,
    citationKey: row.citation_key,
    journal: row.journal,
    volume: row.volume,
    issue: row.issue,
    pages: row.pages,
    url: row.url,
    abstract: row.abstract,
    keywords: row.keywords,
    pdfSourceUrl: row.pdf_source_url,
    bibtexSourceUrl: row.bibtex_source_url,
    sourceAdapter: row.source_adapter,
    metadataProvenance: parseProvenance(row.metadata_provenance_json),
    fileHash: row.file_hash,
    relativeDir: row.relative_dir,
    originalFileName: row.original_file_name,
    parseStatus: row.parse_status,
    parseError: row.parse_error,
    parserVersion: row.parser_version,
    parseRevision: row.parse_revision,
    parsedAt: row.parsed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toParseJobRecord(row: ParseJobRow): ParseJobRecord {
  return {
    id: row.id, workspacePath: row.workspace_path, paperId: row.paper_id, status: row.status,
    currentPage: row.current_page, totalPages: row.total_pages, chunkCount: row.chunk_count, error: row.error,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  }
}

export function toVisionJobRecord(row: VisionJobRow): VisionJobRecord {
  return {
    id: row.id, workspacePath: row.workspace_path, figureId: row.figure_id, status: row.status,
    error: row.error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  }
}

export function toEmbeddingJobRecord(row: EmbeddingJobRow): EmbeddingJobRecord {
  return {
    id: row.id, workspacePath: row.workspace_path, paperId: row.paper_id, parseRevision: row.parse_revision,
    provider: row.provider, model: row.model, dimensions: row.dimensions, status: row.status,
    totalItems: row.total_items, completedItems: row.completed_items, error: row.error, retryCount: row.retry_count,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at,
  }
}

/** Tolerates malformed historical JSON while keeping imported source evidence local. */
function parseProvenance(value: string | null): readonly { readonly source: string; readonly url: string }[] {
  if (value === null || value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(item => {
      if (item === null || typeof item !== 'object') return []
      const record = item as { readonly source?: unknown; readonly url?: unknown }
      if (typeof record.source !== 'string' || record.source.trim() === '') return []
      if (typeof record.url !== 'string' || record.url.trim() === '') return []
      return [{ source: record.source, url: record.url }]
    })
  } catch {
    return []
  }
}

export function toPaperFigureRecord(row: PaperFigureRow): PaperFigureRecord {
  return {
    id: row.id, paperId: row.paper_id, workspacePath: row.workspace_path, elementId: row.element_id ?? null, figureLabel: row.figure_label,
    pageNumber: row.page_number, sectionTitle: row.section_title, relativePath: row.relative_path, mimeType: row.mime_type, sha256: row.sha256,
    rawCaption: row.raw_caption, nearbyText: row.nearby_text, visionDescription: row.vision_description, visionStatus: row.vision_status,
    visionModel: row.vision_model, visionPromptVersion: row.vision_prompt_version, visionError: row.vision_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function toPaperFigureCitation(workspace: string, row: PaperFigureRow & { paper_title: string; paper_relative_dir: string }): PaperFigureCitation {
  return {
    id: row.id, paperId: row.paper_id, elementId: row.element_id ?? null, title: row.paper_title, figureLabel: row.figure_label,
    sectionTitle: row.section_title, pdfPage: row.page_number, rawCaption: row.raw_caption, nearbyText: row.nearby_text,
    visionDescription: row.vision_description,
    imagePath: workspaceDataPath(workspace, join(row.paper_relative_dir, row.relative_path)),
  }
}
