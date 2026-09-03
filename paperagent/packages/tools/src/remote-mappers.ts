import type { PaperRecord } from '@paperagent/domain'

export function toPaperSummary(paper: PaperRecord, embeddingStatus?: { status: string; totalItems: number; completedItems: number; error: string | null }) {
  return {
    id: paper.id, libraryId: paper.libraryId, title: paper.title, authors: [...paper.authors], year: paper.year,
    originalFileName: paper.originalFileName, parseStatus: paper.parseStatus, parseError: paper.parseError,
    parsedAt: paper.parsedAt, updatedAt: paper.updatedAt,
    indexing: embeddingStatus ?? { status: 'not_indexed', totalItems: 0, completedItems: 0, error: null },
  }
}

export function toPaperDetail(paper: PaperRecord, embeddingStatus?: { status: string; totalItems: number; completedItems: number; error: string | null }) {
  return {
    ...toPaperSummary(paper, embeddingStatus), doi: paper.doi, bibtex: paper.bibtex, citationKey: paper.citationKey,
    journal: paper.journal, volume: paper.volume, issue: paper.issue, pages: paper.pages, url: paper.url,
    abstract: paper.abstract, keywords: paper.keywords, fileHash: paper.fileHash, parserVersion: paper.parserVersion,
    parsedAt: paper.parsedAt, createdAt: paper.createdAt, pdfSourceUrl: paper.pdfSourceUrl,
    bibtexSourceUrl: paper.bibtexSourceUrl, sourceAdapter: paper.sourceAdapter,
    metadataProvenance: paper.metadataProvenance.map(item => ({ ...item })),
  }
}
