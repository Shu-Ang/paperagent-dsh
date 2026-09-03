import type { PaperElementType, PaperSearchFilter } from './models.ts'

export interface PaperAgentStoreOptions {
  readonly databasePath: string
  readonly maxPdfBytes: number
}

export interface CreateLibraryInput {
  readonly workspacePath: string
  readonly name: string
}

export interface ImportPaperInput {
  readonly workspacePath: string
  readonly libraryId?: string
  readonly sourcePath: string
  /** Original browser file name when the source is a controlled temporary upload. */
  readonly originalFileName?: string
  readonly title?: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly doi?: string
  readonly bibtex?: string
}

export interface FindInPaperMarkdownInput {
  readonly workspacePath: string
  readonly paperId: string
  readonly query: string
  readonly mode?: 'literal' | 'regex'
  readonly limit?: number
}

export interface ReadPaperSectionInput {
  readonly workspacePath: string
  readonly paperId: string
  /** Parsed section title, or an unambiguous heading number such as "3" / "3.1". Mutually exclusive with explicit line bounds. */
  readonly section?: string
  readonly lineStart?: number
  readonly lineEnd?: number
  readonly maxChars?: number
}

export interface SearchPaperElementsInput {
  readonly workspacePath: string
  readonly query: string
  readonly types?: readonly PaperElementType[]
  readonly limit?: number
  readonly filter?: PaperSearchFilter
}

export interface ReadPaperElementInput {
  readonly workspacePath: string
  readonly elementId: string
  readonly maxChars?: number
}

export interface CreatePaperFigureInput {
  readonly id?: string
  readonly elementId?: string | null
  readonly paperId: string
  readonly workspacePath: string
  readonly figureLabel?: string | null
  readonly pageNumber: number
  readonly sectionTitle: string
  readonly relativePath: string
  readonly mimeType: string
  readonly sha256: string
  readonly rawCaption: string
  readonly nearbyText: string
}

export interface UpdatePaperMetadataInput {
  readonly workspacePath: string
  readonly paperId: string
  readonly patch: {
    readonly title?: string
    readonly authors?: readonly string[]
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
}

/** Changes only a paper's library classification; managed artifacts stay put. */
export interface MovePaperInput {
  readonly workspacePath: string
  readonly paperId: string
  readonly libraryId: string | null
}

export interface CreatePaperFromBibtexInput {
  readonly workspacePath: string
  readonly libraryId?: string
  readonly bibtex: string
}

export interface ReplacePaperPdfInput {
  readonly workspacePath: string
  readonly paperId: string
  readonly sourcePath: string
  readonly originalFileName?: string
}
