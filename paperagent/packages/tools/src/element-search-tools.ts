import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperAgentStore } from '@paperagent/domain'
import type { PaperElementType } from '@paperagent/domain'
import type { PaperCitationElementType } from '@paperagent/contracts'
import type { PaperRetriever } from '@paperagent/retrieval'
import { nextEvidenceIds, toCitationEvidence } from './evidence.ts'
import { paperCitationPresentationMeta } from './citations.ts'
import { PaperRetrievalTraceCollector } from './retrieval-trace.ts'
import { requireWorkspace } from './runtime.ts'

export interface ElementToolDependencies {
  readonly store: Promise<PaperAgentStore>
  readonly retriever: PaperRetriever
}

/** Registers structured element retrieval tools independently from plugin lifecycle. */
export function registerElementSearchTools(ctx: Context, { store: storePromise, retriever }: ElementToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'read_paper_element',
    description: 'Read one structured paper element returned by search_paper_elements, preserving its type and PDF/Markdown location.',
    parameters: {
      element_id: { type: 'string', required: true, description: 'Element id returned by search_paper_elements.' },
      max_chars: { type: 'number', description: 'Maximum returned characters, from 256 to 12000. Default 6000.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        content: { type: 'string', required: true }, truncated: { type: 'boolean', required: true },
        citation: { type: 'object', required: true, additionalProperties: false, properties: {
          evidenceId: { type: 'string', required: true }, id: { type: 'string', required: true }, paperId: { type: 'string', required: true }, title: { type: 'string', required: true },
          elementType: { type: 'string', required: true }, elementLabel: { type: 'string', required: true }, section: { type: 'string', required: true },
          pdfPageStart: { type: 'number', required: true }, pdfPageEnd: { type: 'number', required: true }, lineStart: { type: 'number', required: true }, lineEnd: { type: 'number', required: true },
          content: { type: 'string', required: true }, caption: { type: 'string', required: true }, excerpt: { type: 'string', required: true },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: `Evidence ID: ${value.citation.evidenceId}\n${value.citation.elementType}: ${value.citation.title}${value.citation.elementLabel === '' ? '' : ` · ${value.citation.elementLabel}`}\nSection: ${value.citation.section}\nPDF pages: ${value.citation.pdfPageStart}-${value.citation.pdfPageEnd}\nMarkdown lines: ${value.citation.lineStart}-${value.citation.lineEnd}\n${value.truncated ? 'Content was truncated to the requested limit.\n' : ''}${value.content}` }],
      presentationMeta: (_args, value) => paperCitationPresentationMeta([toCitationEvidence(value.citation)]),
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const result = store.readPaperElement({ workspacePath: workspace, elementId: args.element_id, ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }) })
      const evidenceId = nextEvidenceIds(execution, 1)[0]!
      return { content: result.content, truncated: result.truncated, citation: {
        evidenceId, id: result.citation.id, paperId: result.citation.paperId, title: result.citation.title,
        elementType: result.citation.elementType as PaperCitationElementType, elementLabel: result.citation.elementLabel ?? '', section: result.citation.section,
        pdfPageStart: result.citation.pdfPageStart, pdfPageEnd: result.citation.pdfPageEnd,
        lineStart: result.citation.lineStart ?? 0, lineEnd: result.citation.lineEnd ?? 0,
        content: result.citation.content, caption: result.citation.caption ?? '', excerpt: result.citation.content.slice(0, 700),
      } }
    },
    presentCall: args => ({ card: 'generic', title: 'Read paper element', kind: 'read', rawInput: args.element_id }),
  }))
  ctx.tools.register(defineTool({
    name: 'search_paper_elements',
    description: 'Search structured paper elements such as figures, tables, and equations. Use this when a question depends on a specific visual or mathematical element.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language query or element caption.' },
      types: { type: 'array', items: { type: 'string' }, description: 'Optional element types: figure, table, equation, code, list.' },
      limit: { type: 'number', description: 'Maximum results from 1 to 20. Default 6.' },
      library_id: { type: 'string', description: 'Optional paper-library id filter.' },
      paper_ids: { type: 'array', items: { type: 'string' }, description: 'Optional owned paper-id filter.' },
      section: { type: 'string', description: 'Optional exact section-title filter.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        elements: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          evidenceId: { type: 'string', required: true }, id: { type: 'string', required: true }, paperId: { type: 'string', required: true }, title: { type: 'string', required: true },
          elementType: { type: 'string', required: true }, elementLabel: { type: 'string', required: true }, section: { type: 'string', required: true },
          pdfPageStart: { type: 'number', required: true }, pdfPageEnd: { type: 'number', required: true }, lineStart: { type: 'number', required: true }, lineEnd: { type: 'number', required: true },
          content: { type: 'string', required: true }, caption: { type: 'string', required: true }, excerpt: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => value.elements.length === 0
        ? [{ type: 'text', text: 'No matching structured paper element was found.' }]
        : value.elements.map(element => ({ type: 'text', text: `Evidence ID: ${element.evidenceId}\n${element.elementType}: ${element.title}${element.elementLabel === '' ? '' : ` · ${element.elementLabel}`}\nSection: ${element.section}\nPDF pages: ${element.pdfPageStart}-${element.pdfPageEnd}\nMarkdown lines: ${element.lineStart}-${element.lineEnd}\n${element.caption}\n${element.content}` })),
      presentationMeta: (_args, value) => paperCitationPresentationMeta(value.elements.map(toCitationEvidence)),
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const trace = new PaperRetrievalTraceCollector()
      const filter = {
        ...(args.library_id === undefined ? {} : { libraryId: args.library_id }),
        ...(args.paper_ids === undefined ? {} : { paperIds: args.paper_ids }),
        ...(args.section === undefined ? {} : { section: args.section }),
      }
      const { hits: elements } = await retriever.searchElements({
        workspacePath: workspace, query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.types === undefined ? {} : { types: args.types as readonly PaperElementType[] }),
        filter, trace,
      })
      trace.record(execution, { toolName: 'search_paper_elements', query: args.query, limit: args.limit ?? 6, filters: {
        ...(args.types === undefined ? {} : { types: [...args.types] }),
        ...(args.library_id === undefined ? {} : { libraryId: args.library_id }),
        ...(args.paper_ids === undefined ? {} : { paperIds: [...args.paper_ids] }),
        ...(args.section === undefined ? {} : { section: args.section }),
      } })
      const evidenceIds = nextEvidenceIds(execution, elements.length)
      return { elements: elements.map((element, index) => ({
        evidenceId: evidenceIds[index]!, id: element.id, paperId: element.paperId, title: element.title,
        elementType: element.elementType as PaperCitationElementType, elementLabel: element.elementLabel ?? '', section: element.section,
        pdfPageStart: element.pdfPageStart, pdfPageEnd: element.pdfPageEnd, lineStart: element.lineStart ?? 0, lineEnd: element.lineEnd ?? 0,
        content: element.content, caption: element.caption ?? '', excerpt: element.content.slice(0, 700),
      })) }
    },
    presentCall: args => ({ card: 'generic', title: 'Search paper elements', kind: 'search', rawInput: args.query }),
  }))
}
