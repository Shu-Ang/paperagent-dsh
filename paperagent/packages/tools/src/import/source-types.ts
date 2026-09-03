/** Provider-neutral paper discovery contracts. These values contain no local paths. */

export type PaperReferenceKind = 'arxiv' | 'doi' | 'url' | 'title'
export type CandidateConfidence = 'high' | 'medium'

export interface NormalizedPaperReference {
  readonly kind: PaperReferenceKind
  readonly value: string
}

export interface SourceProvenance {
  readonly source: string
  readonly url: string
}

export interface ResolvedPaperCandidate {
  readonly id: string
  readonly source: string
  readonly canonicalUrl: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string | null
  readonly abstract: string | null
  readonly bibtex: string | null
  readonly pdfUrl: string | null
  readonly confidence: CandidateConfidence
  readonly provenance: readonly SourceProvenance[]
}

export interface PaperSourceAdapter {
  readonly id: string
  canHandle(reference: NormalizedPaperReference): boolean
  resolve(reference: NormalizedPaperReference): Promise<readonly ResolvedPaperCandidate[]>
}
