import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PaperAgentStore } from '@paperagent/domain'
import { importArxivPaperIntoWorkspace, importPdfUrlIntoWorkspace } from './remote.ts'
import { resolvePaperReference } from './import/adapter-registry.ts'
import { importResolvedCandidate } from './import/paper-import-service.ts'
import type { PaperParseJobs } from './parse-jobs.ts'
import type { MineruPrecisionParser } from '@paperagent/parser-mineru'
import { requireWorkspace } from './runtime.ts'
import { workspaceFilePath } from './evidence.ts'

export interface PaperImportToolOptions {
  readonly store: Promise<PaperAgentStore>
  readonly parseJobs: PaperParseJobs
  readonly parser: MineruPrecisionParser
  readonly afterParse: (workspace: string, paperId: string, signal?: AbortSignal) => Promise<void>
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs: number
  readonly maxDownloadRedirects: number
}

/** Registers import, source resolution, and MinerU parse tools as one cohesive group. */
export function registerPaperImportTools(ctx: Context, options: PaperImportToolOptions): void {
  const { store, parseJobs, parser, afterParse, maxPdfBytes, downloadTimeoutMs, maxDownloadRedirects } = options
  ctx.tools.register(defineTool({
    name: 'import_paper_pdf',
    description: 'Import one PDF that is already inside the active workspace. The original is copied into the managed local PaperAgent folder. Never use a path outside the workspace.',
    parameters: {
      source_path: { type: 'string', required: true, description: 'Relative or absolute PDF path inside the active workspace.' },
      library_id: { type: 'string', description: 'Optional target paper library id.' },
      title: { type: 'string', description: 'Optional display title; defaults to the file name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, duplicate: { type: 'boolean', required: true }, parseStatus: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.duplicate ? `Paper already exists: ${value.title} (${value.id}).` : `Imported ${value.title} (${value.id}). Parse it before answering questions about its contents.` }],
    },
    async execute(args, execution) {
      const domain = await store
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const result = await domain.importPaper({ workspacePath: workspace, sourcePath: workspaceFilePath(workspace, args.source_path), ...(args.library_id === undefined ? {} : { libraryId: args.library_id }), ...(args.title === undefined ? {} : { title: args.title }) })
      return { id: result.paper.id, title: result.paper.title, duplicate: result.duplicate, parseStatus: result.paper.parseStatus }
    },
    presentCall: args => ({ card: 'generic', title: 'Import paper PDF', kind: 'edit', rawInput: args.source_path }),
  }))

  ctx.tools.register(defineTool({
    name: 'import_paper_from_url',
    description: 'Import a paper from a direct public HTTPS PDF URL into the active workspace. The URL is downloaded with redirect, private-network, size, and PDF-signature checks, then parsed asynchronously by MinerU. This tool does not infer BibTeX or other bibliographic metadata.',
    parameters: { pdf_url: { type: 'string', required: true, description: 'Direct public HTTPS link to a PDF file.' }, library_id: { type: 'string', description: 'Optional target paper-library id; omit for Unclassified.' }, title: { type: 'string', description: 'Optional paper title; otherwise the PDF filename is used.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, duplicate: { type: 'boolean', required: true }, parseStatus: { type: 'string', required: true }, jobId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.duplicate ? `Paper already exists: ${value.title} (${value.id}).` : `Imported ${value.title} (${value.id}) from a PDF URL; MinerU parsing has started asynchronously.` }],
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const result = await importPdfUrlIntoWorkspace({ store, maxPdfBytes, parseJobs, downloadTimeoutMs, maxDownloadRedirects }, workspace, { url: args.pdf_url, libraryId: args.library_id ?? null, ...(args.title === undefined ? {} : { title: args.title }) })
      return { ...result, jobId: result.jobId ?? '' }
    },
    presentCall: args => ({ card: 'generic', title: 'Import paper from URL', kind: 'execute', rawInput: args.pdf_url }),
  }))

  ctx.tools.register(defineTool({
    name: 'import_arxiv_paper',
    description: 'Import an arXiv paper from its official HTTPS URL into the active workspace. Downloads the official PDF, stores generated BibTeX and metadata, and starts asynchronous MinerU parsing. Use list_paper_libraries first when the user names a target library.',
    parameters: { arxiv_url: { type: 'string', required: true, description: 'Official arXiv URL, for example https://arxiv.org/abs/2501.01234.' }, library_id: { type: 'string', description: 'Optional target paper-library id; omit for Unclassified.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, duplicate: { type: 'boolean', required: true }, parseStatus: { type: 'string', required: true }, jobId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.duplicate ? `Paper already exists: ${value.title} (${value.id}).` : `Imported ${value.title} (${value.id}); MinerU parsing has started asynchronously.` }],
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const result = await importArxivPaperIntoWorkspace({ store, maxPdfBytes, parseJobs, downloadTimeoutMs, maxDownloadRedirects }, workspace, { url: args.arxiv_url, libraryId: args.library_id ?? null })
      return { ...result, jobId: result.jobId ?? '' }
    },
    presentCall: args => ({ card: 'generic', title: 'Import arXiv paper', kind: 'execute', rawInput: args.arxiv_url }),
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_paper_reference',
    description: 'Resolve an arXiv URL, DOI, or direct public PDF URL into verified paper candidates. Title-only discovery must use web_search first, then pass a verified source URL to this tool.',
    parameters: { reference: { type: 'string', required: true, description: 'An arXiv URL, DOI, DOI URL, or direct public HTTPS PDF URL.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { candidate_id: { type: 'string', required: true, description: 'Stable candidate identifier. Pass this exact value to import_resolved_paper.candidate_id.' }, source: { type: 'string', required: true }, canonicalUrl: { type: 'string', required: true }, title: { type: 'string', required: true }, authors: { type: 'array', required: true, items: { type: 'string' } }, year: { type: 'number' }, doi: { type: 'string' }, abstract: { type: 'string' }, bibtex: { type: 'string' }, pdfUrl: { type: 'string' }, confidence: { type: 'string', required: true }, provenance: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { source: { type: 'string', required: true }, url: { type: 'string', required: true } } } } } } } } },
      render: (_args, value) => [{ type: 'text', text: value.candidates.length === 0 ? 'No supported paper source was resolved.' : value.candidates.map(candidate => `${candidate.title} — ${candidate.source}; candidate_id: ${candidate.candidate_id}; PDF: ${candidate.pdfUrl === undefined ? 'unavailable' : 'available'}; BibTeX: ${candidate.bibtex === undefined ? 'unavailable' : 'available'}.`).join('\n') }],
    },
    async execute(args) {
      const candidates = await resolvePaperReference(args.reference)
      return { candidates: candidates.map(candidate => ({ candidate_id: candidate.id, source: candidate.source, canonicalUrl: candidate.canonicalUrl, title: candidate.title, authors: [...candidate.authors], confidence: candidate.confidence, provenance: candidate.provenance.map(item => ({ source: item.source, url: item.url })), ...(candidate.year === null ? {} : { year: candidate.year }), ...(candidate.doi === null ? {} : { doi: candidate.doi }), ...(candidate.abstract === null ? {} : { abstract: candidate.abstract }), ...(candidate.bibtex === null ? {} : { bibtex: candidate.bibtex }), ...(candidate.pdfUrl === null ? {} : { pdfUrl: candidate.pdfUrl }) })) }
    },
    presentCall: args => ({ card: 'generic', title: 'Resolve paper reference', kind: 'read', rawInput: args.reference }),
  }))

  ctx.tools.register(defineTool({
    name: 'import_resolved_paper',
    description: 'Import one candidate previously returned by resolve_paper_reference. The candidate is resolved again before download, then its public PDF and/or trusted BibTeX are imported into the active workspace.',
    parameters: { reference: { type: 'string', required: true, description: 'The same reference passed to resolve_paper_reference.' }, candidate_id: { type: 'string', required: true, description: 'Exact candidate id returned by resolve_paper_reference.' }, library_id: { type: 'string', description: 'Optional target paper-library id; omit for Unclassified.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, duplicate: { type: 'boolean', required: true }, parseStatus: { type: 'string', required: true }, jobId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.duplicate ? `Paper already exists: ${value.title} (${value.id}).` : value.jobId === '' ? `Imported BibTeX metadata for ${value.title} (${value.id}); no public PDF was available.` : `Imported ${value.title} (${value.id}); MinerU parsing has started asynchronously.` }],
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const candidates = await resolvePaperReference(args.reference)
      const candidate = candidates.find(item => item.id === args.candidate_id)
      if (candidate === undefined) throw new Error('the requested paper candidate is no longer available for this reference')
      const result = await importResolvedCandidate({ store, parseJobs, maxPdfBytes, downloadTimeoutMs, maxDownloadRedirects }, { workspacePath: workspace, libraryId: args.library_id ?? null, candidate })
      return { ...result, jobId: result.jobId ?? '' }
    },
    presentCall: args => ({ card: 'generic', title: 'Import resolved paper', kind: 'execute', rawInput: args.reference }),
  }))

  ctx.tools.register(defineTool({
    name: 'parse_paper_to_markdown',
    description: 'Parse an imported local paper into Markdown. This creates paper.md and source-map.json with PDF-page and Markdown-line citations.',
    parameters: { paper_id: { type: 'string', required: true, description: 'Imported paper id.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { paperId: { type: 'string', required: true }, markdownPath: { type: 'string', required: true }, sourceMapPath: { type: 'string', required: true }, chunkCount: { type: 'number', required: true }, elementCount: { type: 'number', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Parsed ${value.paperId}: ${value.chunkCount} text chunks and ${value.elementCount} structured elements. Markdown: ${value.markdownPath}` }],
    },
    async execute(args, execution) {
      const domain = await store
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const artifact = await parser.parse(domain, workspace, args.paper_id)
      await afterParse(workspace, args.paper_id)
      return { paperId: artifact.paper.id, markdownPath: artifact.markdownPath, sourceMapPath: artifact.sourceMapPath, chunkCount: artifact.chunkCount, elementCount: artifact.elementCount }
    },
    presentCall: args => ({ card: 'generic', title: 'Parse paper to Markdown', kind: 'execute', rawInput: args.paper_id }),
  }))
}
