import type { EmbeddingJobStatus, FigureVisionStatus, PaperElementContentFormat, PaperElementType, ParseJobStatus, ParseStatus, VisionJobStatus } from './models.ts'

export interface LibraryRow {
  id: string
  workspace_path: string
  name: string
  paper_count: number
  created_at: string
  updated_at: string
}

export interface PaperRow {
  id: string
  workspace_path: string
  library_id: string | null
  title: string
  authors: string
  year: number | null
  doi: string | null
  bibtex: string | null
  citation_key: string | null
  journal: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  url: string | null
  abstract: string | null
  keywords: string | null
  pdf_source_url: string | null
  bibtex_source_url: string | null
  source_adapter: string | null
  metadata_provenance_json: string | null
  file_hash: string
  relative_dir: string
  original_file_name: string
  parse_status: ParseStatus
  parse_error: string | null
  parser_version: string | null
  parse_revision: string | null
  parsed_at: string | null
  created_at: string
  updated_at: string
}

export interface PaperChunkRow {
  id: string
  paper_id: string
  workspace_path: string
  section: string
  section_id: string | null
  parent_section_id: string | null
  chunk_type: 'child' | null
  sequence: number | null
  pdf_page_start: number
  pdf_page_end: number
  line_start: number
  line_end: number
  content: string
  created_at: string
}

export interface PaperSectionRow {
  id: string
  paper_id: string
  workspace_path: string
  title: string
  level: number
  parent_id: string | null
  path: string
  pdf_page_start: number
  pdf_page_end: number
  line_start: number
  line_end: number
  reading_order: number
  created_at: string
}

export interface PaperElementRow {
  id: string
  paper_id: string
  workspace_path: string
  element_type: PaperElementType
  section: string
  section_id: string | null
  parent_section_id: string | null
  pdf_page_start: number
  pdf_page_end: number
  line_start: number | null
  line_end: number | null
  reading_order: number
  content: string
  caption: string | null
  content_format: PaperElementContentFormat
  created_at: string
  updated_at: string
  paper_relative_dir?: string
}

export interface PaperReferenceRow {
  id: string
  paper_id: string
  workspace_path: string
  ordinal: number
  label: string | null
  raw_text: string
  authors_json: string
  title: string | null
  year: number | null
  venue: string | null
  doi: string | null
  url: string | null
  section: string
  pdf_page_start: number
  pdf_page_end: number
  line_start: number | null
  line_end: number | null
  created_at: string
  updated_at: string
}

export interface PaperFigureRow {
  id: string
  paper_id: string
  workspace_path: string
  element_id: string | null
  figure_label: string | null
  page_number: number
  section_title: string
  relative_path: string
  mime_type: string
  sha256: string
  raw_caption: string
  nearby_text: string
  vision_description: string | null
  vision_status: FigureVisionStatus
  vision_model: string | null
  vision_prompt_version: string | null
  vision_error: string | null
  created_at: string
  updated_at: string
}

export interface ParseJobRow {
  id: string
  workspace_path: string
  paper_id: string
  status: ParseJobStatus
  current_page: number | null
  total_pages: number | null
  chunk_count: number | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface VisionJobRow {
  id: string
  workspace_path: string
  figure_id: string
  status: VisionJobStatus
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface EmbeddingJobRow {
  id: string
  workspace_path: string
  paper_id: string
  parse_revision: string
  provider: string
  model: string
  dimensions: number
  status: EmbeddingJobStatus
  total_items: number
  completed_items: number
  error: string | null
  retry_count: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}
