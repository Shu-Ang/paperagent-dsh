export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

export interface Library { readonly id: string; readonly name: string; readonly paperCount: number }
export interface Paper {
  readonly id: string
  readonly libraryId: string | null
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly originalFileName: string
  readonly parseStatus: 'metadata' | 'queued' | 'parsing' | 'ready' | 'failed'
  readonly parseError: string | null
  readonly updatedAt: string
  readonly indexing: PaperIndexingStatus
}
export interface PaperIndexingStatus { readonly status: string; readonly totalItems: number; readonly completedItems: number; readonly error: string | null }
export interface PaperDetail extends Paper {
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
  readonly pdfSourceUrl: string | null
  readonly bibtexSourceUrl: string | null
  readonly sourceAdapter: string | null
  readonly metadataProvenance: readonly { readonly source: string; readonly url: string }[]
}
export interface PaperChunkPreview {
  readonly id: string
  readonly sequence: number
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly charCount: number
  readonly content: string
  readonly elements: readonly PaperChunkElementPreview[]
}
export interface PaperChunkElementPreview {
  readonly id: string
  readonly elementType: 'figure' | 'table' | 'equation' | 'code' | 'list'
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly caption: string | null
  readonly contentFormat: 'text' | 'markdown' | 'html' | 'latex' | 'image'
  readonly figureId: string | null
}
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
export interface PaperParseStructure {
  readonly paperId: string
  readonly title: string
  readonly revisionId: string
  readonly parsedAt: string | null
  readonly sectionCount: number
  readonly chunkCount: number
  readonly sections: readonly PaperSectionNode[]
}
export interface PaperImportCandidate {
  readonly id: string
  readonly source: string
  readonly canonicalUrl: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string | null
  readonly pdfUrl: string | null
  readonly bibtexAvailable: boolean
  readonly confidence: 'high' | 'medium'
  readonly provenance: readonly { readonly source: string; readonly url: string }[]
}
export interface ParseJob {
  readonly id: string
  readonly paperId: string
  readonly status: 'queued' | 'parsing' | 'ready' | 'failed' | 'cancelled'
  readonly currentPage: number | null
  readonly totalPages: number | null
  readonly chunkCount: number | null
  readonly error: string | null
}
export interface PaperFigure {
  readonly id: string
  readonly figureLabel: string | null
  readonly pageNumber: number
  readonly sectionTitle: string
  readonly rawCaption: string
  readonly visionDescription: string | null
  readonly visionStatus: 'disabled' | 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'
  readonly visionError: string | null
  readonly updatedAt: string
}
export interface PaperMetadataPatch {
  readonly title?: string
  readonly authors?: string[]
  readonly year?: number | null
  readonly doi?: string | null
  readonly bibtex?: string | null
  readonly citationKey?: string | null
  readonly journal?: string | null
  readonly volume?: string | null
  readonly issue?: string | null
  readonly pages?: string | null
  readonly url?: string | null
  readonly abstract?: string | null
  readonly keywords?: string | null
}
export interface NewPaperDraft {
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string
  readonly citationKey: string
  readonly journal: string
  readonly volume: string
  readonly issue: string
  readonly pages: string
  readonly url: string
  readonly abstract: string
  readonly keywords: string
  readonly bibtex: string
}
export interface PaperAgentApi {
  getVectorSettings(sessionId: string): Promise<Reply<{ embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean; rerankerAvailable?: boolean }>>
  setVectorSettings(sessionId: string, input: { embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean }): Promise<Reply<{ embeddingEnabled: boolean; elasticsearchEnabled: boolean; rerankerEnabled: boolean; rerankerAvailable?: boolean }>>
  listLibraries(sessionId: string): Promise<Reply<Library[]>>
  createLibrary(sessionId: string, name: string): Promise<Reply<Library>>
  renameLibrary(sessionId: string, libraryId: string, name: string): Promise<Reply<Library>>
  deleteLibrary(sessionId: string, libraryId: string): Promise<Reply<{ id: string }>>
  listPapers(sessionId: string, filter: { libraryId?: string | null }): Promise<Reply<Paper[]>>
  getPaper(sessionId: string, paperId: string): Promise<Reply<PaperDetail>>
  getPaperParseStructure(sessionId: string, paperId: string): Promise<Reply<PaperParseStructure>>
  createPaperPdfAccess(sessionId: string, paperId: string): Promise<Reply<{ url: string; expiresAt: number }>>
  testElasticsearch(sessionId: string): Promise<Reply<{ nodeName: string; clusterName: string; version: string }>>
  updatePaperMetadata(sessionId: string, paperId: string, patch: PaperMetadataPatch): Promise<Reply<PaperDetail>>
  movePaper(sessionId: string, paperId: string, libraryId: string | null): Promise<Reply<PaperDetail>>
  deletePaper(sessionId: string, paperId: string): Promise<Reply<{ id: string }>>
  uploadPaper(sessionId: string, input: { fileName: string; base64: string; libraryId: string | null; title?: string }): Promise<Reply<{ id: string; title: string; duplicate: boolean; parseStatus: string }>>
  importArxivPaper(sessionId: string, input: { url: string; libraryId: string | null }): Promise<Reply<{ id: string; title: string; duplicate: boolean; parseStatus: string; jobId: string | null }>>
  resolvePaperReference(sessionId: string, reference: string): Promise<Reply<PaperImportCandidate[]>>
  importPaperReference(sessionId: string, input: { reference: string; libraryId: string | null; candidateId?: string }): Promise<Reply<{ id: string; title: string; duplicate: boolean; parseStatus: string; jobId: string | null }>>
  uploadBibtex(sessionId: string, input: { bibtex: string; libraryId: string | null }): Promise<Reply<{ id: string; title: string; duplicate: boolean; parseStatus: string }>>
  replacePaperPdf(sessionId: string, paperId: string, input: { fileName: string; base64: string }): Promise<Reply<PaperDetail>>
  startParse(sessionId: string, paperId: string): Promise<Reply<ParseJob>>
  reindexPaper(sessionId: string, paperId: string): Promise<Reply<PaperIndexingStatus>>
  getPaperIndexingStatus(sessionId: string, paperId: string): Promise<Reply<PaperIndexingStatus>>
  getParseJob(sessionId: string, jobId: string): Promise<Reply<ParseJob>>
  cancelParse(sessionId: string, jobId: string): Promise<Reply<ParseJob>>
  listPaperFigures(sessionId: string, paperId: string): Promise<Reply<PaperFigure[]>>
  getPaperFigureImage(sessionId: string, figureId: string): Promise<Reply<{ mimeType: string; base64: string }>>
  retryPaperFigureDescription(sessionId: string, figureId: string): Promise<Reply<{ id: string; status: string }>>
}
