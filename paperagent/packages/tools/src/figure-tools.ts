import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperAgentStore } from '@paperagent/domain'
import type { PaperRetriever } from '@paperagent/retrieval'
import { nextEvidenceIds, toFigureCitationEvidence } from './evidence.ts'
import { paperCitationPresentationMeta } from './citations.ts'
import { PaperRetrievalTraceCollector } from './retrieval-trace.ts'
import { requireWorkspace } from './runtime.ts'
import type { PaperVisionJobs } from './vision-jobs.ts'

export interface FigureToolDependencies {
  readonly store: Promise<PaperAgentStore>
  readonly retriever: PaperRetriever
  readonly vision?: PaperVisionJobs
}

/** Registers figure retrieval and visual-description tools independently from plugin lifecycle. */
export function registerFigureTools(ctx: Context, { store: storePromise, retriever, vision }: FigureToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'search_paper_figures',
    description: 'Search locally stored paper figures by original captions, nearby text, and clearly labeled DeepSeek visual descriptions. Cite the returned title, section, PDF page, and figure label.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language image or chart query.' },
      limit: { type: 'number', description: 'Maximum results from 1 to 20. Default 6.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        figures: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          evidenceId: { type: 'string', required: true }, id: { type: 'string', required: true }, paperId: { type: 'string', required: true }, title: { type: 'string', required: true },
          figureLabel: { type: 'string', required: true }, sectionTitle: { type: 'string', required: true }, pdfPage: { type: 'number', required: true },
          rawCaption: { type: 'string', required: true }, visionDescription: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => value.figures.length === 0 ? [{ type: 'text', text: 'No matching paper figure was found.' }]
        : value.figures.map(figure => ({ type: 'text', text: `Evidence ID: ${figure.evidenceId}\n${figure.title} · ${figure.sectionTitle} · PDF p.${figure.pdfPage}${figure.figureLabel === '' ? '' : ` · ${figure.figureLabel}`}\nOriginal caption: ${figure.rawCaption}\nVisual-model description: ${figure.visionDescription}` })),
      presentationMeta: (_args, value) => paperCitationPresentationMeta(value.figures.map(toFigureCitationEvidence)),
    },
    async execute(args, execution) {
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const trace = new PaperRetrievalTraceCollector()
      const { hits: figures } = await retriever.searchFigures({
        workspacePath: workspace, query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }), trace,
      })
      trace.record(execution, { toolName: 'search_paper_figures', query: args.query, limit: args.limit ?? 6, filters: {} })
      const evidenceIds = nextEvidenceIds(execution, figures.length)
      return { figures: figures.map((figure, index) => ({
        evidenceId: evidenceIds[index]!,
        id: figure.id, paperId: figure.paperId, title: figure.title, figureLabel: figure.figureLabel ?? '', sectionTitle: figure.sectionTitle,
        pdfPage: figure.pdfPage, rawCaption: figure.rawCaption, visionDescription: figure.visionDescription ?? '',
      })) }
    },
    presentCall: args => ({ card: 'generic', title: 'Search paper figures', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_paper_figure',
    description: 'Read one owned figure’s original caption, visual-model description, and citation location. Treat the visual description as model interpretation, not paper text.',
    parameters: { figure_id: { type: 'string', required: true, description: 'Figure id returned by search_paper_figures.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      evidenceId: { type: 'string', required: true }, id: { type: 'string', required: true }, paperId: { type: 'string', required: true }, title: { type: 'string', required: true }, figureLabel: { type: 'string', required: true }, sectionTitle: { type: 'string', required: true },
      pdfPage: { type: 'number', required: true }, rawCaption: { type: 'string', required: true }, visionDescription: { type: 'string', required: true }, visionStatus: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `Evidence ID: ${value.evidenceId}\n${value.title} · ${value.sectionTitle} · PDF p.${value.pdfPage}${value.figureLabel === '' ? '' : ` · ${value.figureLabel}`}\nOriginal caption: ${value.rawCaption}\nVisual-model description: ${value.visionDescription}\nStatus: ${value.visionStatus}` }], presentationMeta: (_args, value) => paperCitationPresentationMeta([toFigureCitationEvidence(value)]) },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const figure = store.getPaperFigure(workspace, args.figure_id)
      const paper = store.getPaper(workspace, figure.paperId)
      return {
        evidenceId: nextEvidenceIds(execution, 1)[0]!,
        id: figure.id, paperId: paper.id, title: paper.title, figureLabel: figure.figureLabel ?? '', sectionTitle: figure.sectionTitle, pdfPage: figure.pageNumber,
        rawCaption: figure.rawCaption, visionDescription: figure.visionDescription ?? '', visionStatus: figure.visionStatus,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read paper figure', kind: 'read', rawInput: args.figure_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'retry_paper_figure_description',
    description: 'Retry a failed or queued DeepSeek visual description for one owned paper figure.',
    parameters: { figure_id: { type: 'string', required: true, description: 'Owned figure id.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: `Figure description job ${value.id}: ${value.status}` }] },
    async execute(args, execution) {
      if (vision === undefined) throw new Error('PaperAgent visual descriptions are disabled in plugin configuration')
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const store = await storePromise
      const figure = store.getPaperFigure(workspace, args.figure_id)
      if (figure.visionStatus === 'ready' || figure.visionStatus === 'processing') throw new Error(`figure visual description is already ${figure.visionStatus}`)
      const job = await vision.start(workspace, args.figure_id)
      return { id: job.id, status: job.status }
    },
    presentCall: args => ({ card: 'generic', title: 'Retry figure description', kind: 'execute', rawInput: args.figure_id }),
  }))
}
