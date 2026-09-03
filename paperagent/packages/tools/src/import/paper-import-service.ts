/** The one Host-side bridge from acquired local assets into PaperAgent domain storage. */

import type { PaperAgentStore } from '@paperagent/domain'
import type { PaperParseJobs } from '../parse-jobs.ts'
import { downloadPublicPdf, type DownloadedPublicPdf } from './binary-downloader.ts'
import type { ResolvedPaperCandidate } from './source-types.ts'

export interface PaperImportServiceConfig {
  readonly store: Promise<PaperAgentStore>
  readonly parseJobs: Pick<PaperParseJobs, 'start'>
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs?: number
  readonly maxDownloadRedirects?: number
}

export interface AcquiredPaperMetadata {
  readonly title?: string
  readonly authors?: readonly string[]
  readonly year?: number | null
  readonly doi?: string | null
  readonly bibtex?: string | null
  readonly citationKey?: string | null
  readonly journal?: string | null
  readonly url?: string | null
  readonly abstract?: string | null
  readonly keywords?: string | null
}

export interface ImportAcquiredPdfInput {
  readonly workspacePath: string
  readonly libraryId: string | null
  readonly downloaded: DownloadedPublicPdf
  readonly metadata?: AcquiredPaperMetadata
}

export interface ImportedAcquiredPaper {
  readonly id: string
  readonly title: string
  readonly duplicate: boolean
  readonly parseStatus: string
  readonly jobId: string | null
}

/** Imports an adapter-verified candidate, with a BibTeX-only fallback when no public PDF exists. */
export async function importResolvedCandidate(
  config: PaperImportServiceConfig,
  input: { readonly workspacePath: string; readonly libraryId: string | null; readonly candidate: ResolvedPaperCandidate },
): Promise<ImportedAcquiredPaper> {
  const metadata: AcquiredPaperMetadata = {
    title: input.candidate.title,
    authors: input.candidate.authors,
    year: input.candidate.year,
    doi: input.candidate.doi,
    bibtex: input.candidate.bibtex,
    url: input.candidate.canonicalUrl,
    abstract: input.candidate.abstract,
  }
  if (input.candidate.pdfUrl !== null) {
    const downloaded = await downloadPublicPdf({
      workspacePath: input.workspacePath,
      url: input.candidate.pdfUrl,
      maxBytes: config.maxPdfBytes,
      ...(config.downloadTimeoutMs === undefined ? {} : { timeoutMs: config.downloadTimeoutMs }),
      ...(config.maxDownloadRedirects === undefined ? {} : { maxRedirects: config.maxDownloadRedirects }),
      preferredFileName: `${input.candidate.title}.pdf`,
    })
    try {
      const result = await importAcquiredPdf(config, {
        workspacePath: input.workspacePath, libraryId: input.libraryId, downloaded, metadata,
      })
      await persistCandidateProvenance(config, input.workspacePath, result.id, input.candidate)
      return result
    } finally {
      await downloaded.cleanup()
    }
  }
  if (input.candidate.bibtex === null) throw new Error('this source provides neither a public PDF nor BibTeX to import')
  const store = await config.store
  const imported = store.createPaperFromBibtex({
    workspacePath: input.workspacePath,
    ...(input.libraryId === null ? {} : { libraryId: input.libraryId }),
    bibtex: input.candidate.bibtex,
  })
  if (imported.duplicate) {
    mergeAcquiredMetadata(store, input.workspacePath, imported.paper.id, metadata)
    await persistCandidateProvenance(config, input.workspacePath, imported.paper.id, input.candidate)
    return {
      id: imported.paper.id, title: imported.paper.title, duplicate: true,
      parseStatus: imported.paper.parseStatus, jobId: null,
    }
  }
  const paper = store.updatePaperMetadata({
    workspacePath: input.workspacePath,
    paperId: imported.paper.id,
    patch: {
      title: input.candidate.title,
      authors: [...input.candidate.authors],
      year: input.candidate.year,
      doi: input.candidate.doi,
      bibtex: input.candidate.bibtex,
      url: input.candidate.canonicalUrl,
      abstract: input.candidate.abstract,
    },
  })
  await persistCandidateProvenance(config, input.workspacePath, paper.id, input.candidate)
  return { id: paper.id, title: paper.title, duplicate: false, parseStatus: paper.parseStatus, jobId: null }
}

async function persistCandidateProvenance(
  config: PaperImportServiceConfig,
  workspacePath: string,
  paperId: string,
  candidate: ResolvedPaperCandidate,
): Promise<void> {
  const store = await config.store
  const paper = store.getPaper(workspacePath, paperId)
  const provenance = [...paper.metadataProvenance, ...candidate.provenance]
    .filter((item, index, values) => values.findIndex(other => other.source === item.source && other.url === item.url) === index)
  store.setPaperImportProvenance({
    workspacePath,
    paperId,
    pdfSourceUrl: candidate.pdfUrl,
    bibtexSourceUrl: candidate.bibtex === null ? null : candidate.canonicalUrl,
    sourceAdapter: candidate.source,
    metadataProvenance: provenance,
  })
}

/**
 * Imports an already-downloaded local asset, records source metadata, and starts
 * the existing asynchronous MinerU workflow. It never performs network access.
 */
export async function importAcquiredPdf(
  config: PaperImportServiceConfig,
  input: ImportAcquiredPdfInput,
): Promise<ImportedAcquiredPaper> {
  const store = await config.store
  const metadata = input.metadata
  const imported = await store.importPaper({
    workspacePath: input.workspacePath,
    sourcePath: input.downloaded.localPath,
    originalFileName: input.downloaded.fileName,
    ...(input.libraryId === null ? {} : { libraryId: input.libraryId }),
    ...(metadata?.title === undefined || metadata.title.trim() === '' ? {} : { title: metadata.title }),
    ...(metadata?.authors === undefined ? {} : { authors: [...metadata.authors] }),
    ...(metadata?.year === undefined || metadata.year === null ? {} : { year: metadata.year }),
    ...(metadata?.doi === undefined || metadata.doi === null ? {} : { doi: metadata.doi }),
    ...(metadata?.bibtex === undefined || metadata.bibtex === null ? {} : { bibtex: metadata.bibtex }),
  })
  if (imported.duplicate) {
    mergeAcquiredMetadata(store, input.workspacePath, imported.paper.id, metadata)
    return {
      id: imported.paper.id, title: imported.paper.title, duplicate: true,
      parseStatus: imported.paper.parseStatus, jobId: null,
    }
  }
  const paper = store.updatePaperMetadata({
    workspacePath: input.workspacePath,
    paperId: imported.paper.id,
    patch: {
      ...(metadata?.title === undefined ? {} : { title: metadata.title }),
      ...(metadata?.authors === undefined ? {} : { authors: [...metadata.authors] }),
      ...(metadata?.year === undefined ? {} : { year: metadata.year }),
      ...(metadata?.doi === undefined ? {} : { doi: metadata.doi }),
      ...(metadata?.bibtex === undefined ? {} : { bibtex: metadata.bibtex }),
      ...(metadata?.citationKey === undefined ? {} : { citationKey: metadata.citationKey }),
      ...(metadata?.journal === undefined ? {} : { journal: metadata.journal }),
      ...(metadata?.url === undefined ? {} : { url: metadata.url }),
      ...(metadata?.abstract === undefined ? {} : { abstract: metadata.abstract }),
      ...(metadata?.keywords === undefined ? {} : { keywords: metadata.keywords }),
    },
  })
  const job = await config.parseJobs.start(input.workspacePath, paper.id)
  return { id: paper.id, title: paper.title, duplicate: false, parseStatus: 'queued', jobId: job.id }
}

/** Never overwrite user-edited values on duplicate PDF imports; only enrich blanks. */
function mergeAcquiredMetadata(store: PaperAgentStore, workspacePath: string, paperId: string, metadata: AcquiredPaperMetadata | undefined): void {
  if (metadata === undefined) return
  const current = store.getPaper(workspacePath, paperId)
  store.updatePaperMetadata({
    workspacePath, paperId,
    patch: {
      ...(current.title.trim() === '' && metadata.title !== undefined ? { title: metadata.title } : {}),
      ...(current.authors.length === 0 && metadata.authors !== undefined ? { authors: metadata.authors } : {}),
      ...(current.year === null && metadata.year !== undefined ? { year: metadata.year } : {}),
      ...(current.doi === null && metadata.doi !== undefined ? { doi: metadata.doi } : {}),
      ...(current.bibtex === null && metadata.bibtex !== undefined ? { bibtex: metadata.bibtex } : {}),
      ...(current.citationKey === null && metadata.citationKey !== undefined ? { citationKey: metadata.citationKey } : {}),
      ...(current.journal === null && metadata.journal !== undefined ? { journal: metadata.journal } : {}),
      ...(current.url === null && metadata.url !== undefined ? { url: metadata.url } : {}),
      ...(current.abstract === null && metadata.abstract !== undefined ? { abstract: metadata.abstract } : {}),
      ...(current.keywords === null && metadata.keywords !== undefined ? { keywords: metadata.keywords } : {}),
    },
  })
}
