/** Domain record types for the local PaperAgent plugin. */

export type ParseStatus = 'metadata' | 'queued' | 'parsing' | 'ready' | 'failed'
export type ParseJobStatus = 'queued' | 'parsing' | 'ready' | 'failed' | 'cancelled'

/** Durable host-side MinerU job state; it survives a DSH process restart. */
export interface ParseJobRecord {
  readonly id: string
  readonly workspacePath: string
  readonly paperId: string
  readonly status: ParseJobStatus
  readonly currentPage: number | null
  readonly totalPages: number | null
  readonly chunkCount: number | null
  readonly error: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export type VisionJobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'

/** Durable visual-description queue state; one row belongs to one figure. */
export interface VisionJobRecord {
  readonly id: string
  readonly workspacePath: string
  readonly figureId: string
  readonly status: VisionJobStatus
  readonly error: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface LibraryRecord {
  readonly id: string
  readonly workspacePath: string
  readonly name: string
  readonly paperCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PaperRecord {
  readonly id: string
  readonly workspacePath: string
  readonly libraryId: string | null
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string | null
  readonly bibtex: string | null
  readonly citationKey: string | null
  readonly journal: string | null
  readonly volume: string | null
  readonly issue: string | null
  readonly pages: string | null
  readonly url: string | null
  readonly abstract: string | null
  readonly keywords: string | null
  /** Acquisition provenance is system-owned and never edited as bibliography metadata. */
  readonly pdfSourceUrl: string | null
  readonly bibtexSourceUrl: string | null
  readonly sourceAdapter: string | null
  readonly metadataProvenance: readonly { readonly source: string; readonly url: string }[]
  readonly fileHash: string
  readonly relativeDir: string
  readonly originalFileName: string
  readonly parseStatus: ParseStatus
  readonly parseError: string | null
  readonly parserVersion: string | null
  /** Immutable artifact revision currently referenced by the SQLite index. */
  readonly parseRevision: string | null
  readonly parsedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Validation state for a PaperAgent BibTeX entry exposed to LaTeX workflows. */
export type PaperBibliographyStatus = 'ready' | 'missing-bibtex' | 'invalid-bibtex' | 'missing-citation-key'

/** Read-only bibliography data scoped to one active DSH workspace. */
export interface PaperBibliographyEntry {
  readonly paperId: string
  readonly title: string
  readonly citationKey: string | null
  readonly bibtex: string | null
  readonly doi: string | null
  readonly sourceAdapter: string | null
  readonly metadataStatus: PaperBibliographyStatus
}

/** One searchable, citeable Markdown interval produced from MinerU structured output. */
export interface PaperChunkRecord {
  readonly id: string
  readonly paperId: string
  readonly workspacePath: string
  readonly section: string
  /** Stable logical section node owning this child chunk. */
  readonly sectionId?: string
  /** Immediate parent section node, null for the document root. */
  readonly parentSectionId?: string | null
  /** Chunk kind; searchable正文 chunks are always `child`. */
  readonly chunkType?: 'child'
  /** Monotonic order among chunks in the owning section. */
  readonly sequence?: number
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly content: string
  readonly elementIds?: readonly string[]
  readonly createdAt: string
}

/** A durable heading tree node. Section nodes provide context and boundaries;
 * their text is read from Markdown rather than duplicated in SQLite. */
export interface PaperSectionRecord {
  readonly id: string
  readonly paperId: string
  readonly workspacePath: string
  readonly title: string
  readonly level: number
  readonly parentId: string | null
  readonly path: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly readingOrder: number
  readonly createdAt: string
}

/** A structured element attached to a child chunk in the parse-structure UI. */
export interface PaperChunkElementPreview {
  readonly id: string
  readonly elementType: PaperElementType
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly caption: string | null
  readonly contentFormat: PaperElementContentFormat
  /** The related figure row, when the element has a locally stored image. */
  readonly figureId: string | null
}

/** Full child-chunk projection used by the parse-structure UI. */
export interface PaperChunkPreview {
  readonly id: string
  readonly sequence: number
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly charCount: number
  /** Complete chunk text; the UI must not truncate this value. */
  readonly content: string
  readonly elements: readonly PaperChunkElementPreview[]
}

/** A section node with only the data needed to visualize the parse result. */
export interface PaperSectionNode {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly level: number
  readonly parentId: string | null
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly chunkCount: number
  readonly chunks: readonly PaperChunkPreview[]
  readonly children: readonly PaperSectionNode[]
}

/** Read-only parse tree returned to the PaperAgent browser UI. */
export interface PaperParseStructure {
  readonly paperId: string
  readonly title: string
  readonly revisionId: string
  readonly parsedAt: string | null
  readonly sectionCount: number
  readonly chunkCount: number
  readonly sections: readonly PaperSectionNode[]
}

export type PaperElementType = 'figure' | 'table' | 'equation' | 'code' | 'list'
export const STRUCTURED_PAPER_ELEMENT_TYPES: readonly PaperElementType[] = ['figure', 'table', 'equation', 'code', 'list']
export type PaperElementContentFormat = 'text' | 'markdown' | 'html' | 'latex' | 'image'

/** One structured MinerU content element with durable source coordinates. */
export interface PaperElementRecord {
  readonly id: string
  readonly paperId: string
  readonly workspacePath: string
  readonly elementType: PaperElementType
  readonly section: string
  readonly sectionId?: string
  readonly parentSectionId?: string | null
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly readingOrder: number
  readonly content: string
  readonly caption: string | null
  readonly contentFormat: PaperElementContentFormat
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PaperElementCitation {
  readonly id: string
  readonly paperId: string
  readonly title: string
  readonly elementType: PaperElementType
  readonly elementLabel: string | null
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly markdownPath: string
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly caption: string | null
}

export interface PaperElementRead {
  readonly citation: PaperElementCitation
  readonly content: string
  readonly truncated: boolean
}

/** One bibliography entry extracted from the parsed PDF. */
export interface PaperReferenceRecord {
  readonly id: string
  readonly paperId: string
  readonly workspacePath: string
  /** Ordinal shown by the source paper; synthetic when the source is author-year style. */
  readonly ordinal: number
  readonly label: string | null
  readonly rawText: string
  readonly authors: readonly string[]
  readonly title: string | null
  readonly year: number | null
  readonly venue: string | null
  readonly doi: string | null
  readonly url: string | null
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PaperCitation {
  readonly id: string
  readonly paperId: string
  readonly title: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly section: string
  readonly pdfPageStart?: number
  readonly pdfPageEnd?: number
  readonly markdownPath: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly excerpt: string
}

/** A bounded source interval for agent-side fact checking without filesystem access. */
export interface PaperSectionRead {
  readonly citation: PaperCitation
  readonly content: string
  readonly truncated: boolean
}

/** A parsed, readable section exposed to agents before a section read. */
export interface PaperSectionOutline {
  readonly id?: string
  readonly parentId?: string
  readonly path?: string
  /** Exact title accepted by readPaperSection. */
  readonly title: string
  /** Best-effort nesting inferred from a numeric heading, otherwise one. */
  readonly level: number
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
}

/** Optional structured filters shared by FTS and exact-paper retrieval. */
export interface PaperSearchFilter {
  readonly libraryId?: string
  readonly paperIds?: readonly string[]
  readonly section?: string
}

export type FigureVisionStatus = 'disabled' | 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'

/** A locally managed MinerU image and its separately auditable visual description. */
export interface PaperFigureRecord {
  readonly id: string
  readonly paperId: string
  readonly workspacePath: string
  readonly elementId: string | null
  readonly figureLabel: string | null
  readonly pageNumber: number
  readonly sectionTitle: string
  readonly relativePath: string
  readonly mimeType: string
  readonly sha256: string
  readonly rawCaption: string
  readonly nearbyText: string
  readonly visionDescription: string | null
  readonly visionStatus: FigureVisionStatus
  readonly visionModel: string | null
  readonly visionPromptVersion: string | null
  readonly visionError: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PaperFigureCitation {
  readonly id: string
  readonly paperId: string
  readonly elementId: string | null
  readonly title: string
  readonly figureLabel: string | null
  readonly sectionTitle: string
  readonly pdfPage: number
  readonly rawCaption: string
  /** Context extracted around the figure; retained for multimodal reranking. */
  readonly nearbyText?: string
  readonly visionDescription: string | null
  readonly imagePath: string
}

export type EmbeddingJobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'
export type EmbeddingSourceKind = 'chunk' | 'element'
export type EmbeddingContextReason = 'caption' | 'in_text_reference' | 'logical_neighbor' | 'page_fallback' | 'none'

/** One durable asynchronous request to build a paper's derived vector index. */
export interface EmbeddingJobRecord {
  readonly id: string
  readonly workspacePath: string
  readonly paperId: string
  readonly parseRevision: string
  readonly provider: string
  readonly model: string
  readonly dimensions: number
  readonly status: EmbeddingJobStatus
  readonly totalItems: number
  readonly completedItems: number
  readonly error: string | null
  readonly retryCount: number
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly updatedAt: string
}

/**
 * Rebuildable projection sent to an embedding provider. SQLite keeps the
 * identity, structural locations, and selected-context provenance; vectors
 * themselves remain a derived Elasticsearch concern.
 */
export interface PaperEmbeddingSource {
  readonly sourceId: string
  readonly kind: EmbeddingSourceKind
  readonly paperId: string
  readonly workspacePath: string
  readonly libraryId: string | null
  readonly parseRevision: string
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly elementType?: PaperElementType
  readonly text: string
  readonly contextChunkIds: readonly string[]
  readonly contextReason: EmbeddingContextReason
  /** A workspace-relative, managed image. Only a fused/image job may read it. */
  readonly image?: { readonly relativePath: string; readonly mimeType: string }
}
