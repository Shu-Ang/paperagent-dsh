import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperAgentStore } from '@paperagent/domain'
import type { PaperRetriever } from '@paperagent/retrieval'
import { nextEvidenceIds, toCitationEvidence } from './evidence.ts'
import { paperCitationPresentationMeta } from './citations.ts'
import { PaperRetrievalTraceCollector } from './retrieval-trace.ts'
import { requireWorkspace } from './runtime.ts'

export interface SearchToolDependencies {
  readonly store: Promise<PaperAgentStore>
  readonly retriever: PaperRetriever
}

const citationProperties = {
  evidenceId: { type: 'string', required: true },
  id: { type: 'string', required: true },
  paperId: { type: 'string', required: true },
  title: { type: 'string', required: true },
  section: { type: 'string', required: true },
  pdfPageStart: { type: 'number', required: true },
  pdfPageEnd: { type: 'number', required: true },
  markdownPath: { type: 'string', required: true },
  lineStart: { type: 'number', required: true },
  lineEnd: { type: 'number', required: true },
  excerpt: { type: 'string', required: true },
} as const

const citationListSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    citations: {
      type: 'array', required: true,
      items: { type: 'object', additionalProperties: false, properties: citationProperties },
    },
  },
} as const

const paperOutlineSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    paper: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        id: { type: 'string', required: true }, title: { type: 'string', required: true }, parseStatus: { type: 'string', required: true },
      },
    },
    sections: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' }, parentId: { type: 'string' }, path: { type: 'string' },
          title: { type: 'string', required: true }, level: { type: 'number', required: true },
          pdfPageStart: { type: 'number', required: true }, pdfPageEnd: { type: 'number', required: true },
          lineStart: { type: 'number', required: true }, lineEnd: { type: 'number', required: true },
        },
      },
    },
  },
} as const

function citationOutput(citation: {
  readonly id: string
  readonly paperId: string
  readonly title: string
  readonly section: string
  readonly pdfPageStart?: number | null
  readonly pdfPageEnd?: number | null
  readonly markdownPath: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly excerpt: string
}, evidenceId: string) {
  return {
    evidenceId, id: citation.id, paperId: citation.paperId, title: citation.title, section: citation.section,
    pdfPageStart: citation.pdfPageStart ?? 0, pdfPageEnd: citation.pdfPageEnd ?? 0,
    markdownPath: citation.markdownPath, lineStart: citation.lineStart, lineEnd: citation.lineEnd, excerpt: citation.excerpt,
  }
}

/** Registers full-text and exact Markdown search tools independently from plugin lifecycle. */
export function registerSearchTools(ctx: Context, { store: storePromise, retriever }: SearchToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'get_paper_outline',
    description: 'List the exact parsed section tree of one owned paper before reading by section. Call this instead of guessing a section title. Use the returned title or path verbatim with read_paper_section; parent sections include descendants.',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'Owned parsed-paper id.' },
    },
    output: {
      schema: paperOutlineSchema,
      render: (_args, value) => value.sections.length === 0
        ? [{ type: 'text', text: `${value.paper.title} has no readable parsed sections yet (status: ${value.paper.parseStatus}).` }]
        : value.sections.map(section => ({ type: 'text', text: `${'  '.repeat(Math.max(0, section.level - 1))}- ${section.title}${section.path === undefined ? '' : `\n  Path: ${section.path}`}\n  PDF pages: ${section.pdfPageStart}-${section.pdfPageEnd}; Markdown lines: ${section.lineStart}-${section.lineEnd}` })),
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const paper = store.getPaper(workspace, args.paper_id)
      return { paper: { id: paper.id, title: paper.title, parseStatus: paper.parseStatus }, sections: store.listPaperSections(workspace, paper.id) }
    },
    presentCall: args => ({ card: 'generic', title: 'Get paper outline', kind: 'read', rawInput: args.paper_id }),
    presentResult: () => ({ card: 'generic', title: 'Paper outline', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'search_paper_library',
    description: 'Search parsed papers in the active workspace. Use returned source intervals for evidence-backed answers. In final prose, use only the matching bare paperagent-cite:EVIDENCE_ID token, without backticks; do not write title, section, or PDF page citations yourself.',
    parameters: {
      query: { type: 'string', required: true, description: 'The research question or exact phrase to find.' },
      limit: { type: 'number', description: 'Maximum citations to return, from 1 to 20. Default 6.' },
      library_id: { type: 'string', description: 'Optional paper-library id filter.' },
      paper_ids: { type: 'array', items: { type: 'string' }, description: 'Optional owned paper-id filter.' },
      section: { type: 'string', description: 'Optional section title or path filter; matching descendants are included.' },
    },
    output: {
      schema: citationListSchema,
      render: (_args, value) => value.citations.length === 0
        ? [{ type: 'text', text: 'No matching parsed-paper passage was found.' }]
        : value.citations.map(citation => ({ type: 'text', text: `Evidence ID: ${citation.evidenceId}\nPaper: ${citation.title}\nSection: ${citation.section}\nPDF page: ${citation.pdfPageStart}\nMarkdown lines: ${citation.lineStart}-${citation.lineEnd}\nExcerpt: ${citation.excerpt}` })),
      presentationMeta: (_args, value) => paperCitationPresentationMeta(value.citations.map(toCitationEvidence)),
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const filter = {
        ...(args.library_id === undefined ? {} : { libraryId: args.library_id }),
        ...(args.paper_ids === undefined ? {} : { paperIds: args.paper_ids }),
        ...(args.section === undefined ? {} : { section: args.section }),
      }
      const trace = new PaperRetrievalTraceCollector()
      const { hits: citations } = await retriever.searchChunks({
        workspacePath: workspace, query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }),
        filter, trace,
      })
      trace.record(execution, { toolName: 'search_paper_library', query: args.query, limit: args.limit ?? 6, filters: {
        ...(args.library_id === undefined ? {} : { libraryId: args.library_id }),
        ...(args.paper_ids === undefined ? {} : { paperIds: [...args.paper_ids] }),
        ...(args.section === undefined ? {} : { section: args.section }),
      } })
      const evidenceIds = nextEvidenceIds(execution, citations.length)
      return { citations: citations.map((citation, index) => citationOutput(citation, evidenceIds[index]!)) }
    },
    presentCall: args => ({ card: 'generic', title: 'Search paper library', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'find_in_paper_markdown',
    description: 'Perform a bounded literal or regular-expression search inside one owned paper.md. Use only for exact quotations, regex checks, or when FTS retrieval was insufficient.',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'Owned parsed-paper id.' },
      query: { type: 'string', required: true, description: 'Literal text or a bounded regular expression.' },
      mode: { type: 'string', description: 'literal (default) or regex.' },
      limit: { type: 'number', description: 'Maximum matches from 1 to 50. Default 20.' },
    },
    output: {
      schema: citationListSchema,
      render: (_args, value) => value.citations.length === 0
        ? [{ type: 'text', text: 'No exact Markdown match was found.' }]
        : value.citations.map(citation => ({ type: 'text', text: `Evidence ID: ${citation.evidenceId}\nPaper: ${citation.title}\nSection: ${citation.section}\nPDF page: ${citation.pdfPageStart}\nMarkdown line: ${citation.lineStart}\nExcerpt: ${citation.excerpt}` })),
      presentationMeta: (_args, value) => paperCitationPresentationMeta(value.citations.map(toCitationEvidence)),
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const mode = args.mode === undefined || args.mode === 'literal' ? 'literal' : args.mode === 'regex' ? 'regex' : undefined
      if (mode === undefined) throw new Error('find_in_paper_markdown mode must be "literal" or "regex"')
      const citations = await store.findInPaperMarkdown({ workspacePath: workspace, paperId: args.paper_id, query: args.query, mode, ...(args.limit === undefined ? {} : { limit: args.limit }) })
      const evidenceIds = nextEvidenceIds(execution, citations.length)
      return { citations: citations.map((citation, index) => citationOutput(citation, evidenceIds[index]!)) }
    },
    presentCall: args => ({ card: 'generic', title: 'Find in paper Markdown', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_paper_section',
    description: 'Read a bounded section or explicit Markdown line range from one owned parsed paper. Use after search_paper_library when the returned excerpt is insufficient to verify a claim. Before supplying a section title not already returned by search, call get_paper_outline; never guess a title. Never use it to read arbitrary paths.',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'Owned parsed-paper id returned by paper search.' },
      section: { type: 'string', description: 'Prefer the exact section title or path returned by get_paper_outline. Reading a parent includes its descendant sections. Harmless case, whitespace, and heading-number formatting differences are accepted; do not invent a semantic title. Do not combine with line bounds.' },
      line_start: { type: 'number', description: 'Inclusive Markdown line start. Must be provided together with line_end.' },
      line_end: { type: 'number', description: 'Inclusive Markdown line end; at most 500 lines after line_start.' },
      max_chars: { type: 'number', description: 'Maximum returned characters, from 256 to 12000. Default 6000.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          content: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
          citation: { type: 'object', required: true, additionalProperties: false, properties: citationProperties },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Evidence ID: ${value.citation.evidenceId}\nPaper: ${value.citation.title}\nSection: ${value.citation.section}\nPDF page: ${value.citation.pdfPageStart}\nMarkdown lines: ${value.citation.lineStart}-${value.citation.lineEnd}\n${value.truncated ? 'Content was truncated to the requested limit.\n' : ''}${value.content}` }],
      presentationMeta: (_args, value) => paperCitationPresentationMeta([toCitationEvidence(value.citation)]),
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const result = await store.readPaperSection({
        workspacePath: workspace, paperId: args.paper_id,
        ...(args.section === undefined ? {} : { section: args.section }),
        ...(args.line_start === undefined ? {} : { lineStart: args.line_start }),
        ...(args.line_end === undefined ? {} : { lineEnd: args.line_end }),
        ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
      })
      return { content: result.content, truncated: result.truncated, citation: citationOutput(result.citation, nextEvidenceIds(execution, 1)[0]!) }
    },
    presentCall: args => ({ card: 'generic', title: 'Read paper section', kind: 'read', rawInput: args.paper_id }),
  }))
}
