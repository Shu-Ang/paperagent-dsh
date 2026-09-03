import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperAgentStore, PaperReferenceRecord } from '@paperagent/domain'
import { requireWorkspace } from './runtime.ts'

export interface ReferenceToolDependencies {
  readonly store: Promise<PaperAgentStore>
}

const referenceProperties = {
  id: { type: 'string', required: true },
  paperId: { type: 'string', required: true },
  ordinal: { type: 'number', required: true },
  label: { type: 'string', required: true },
  rawText: { type: 'string', required: true },
  authors: { type: 'array', required: true, items: { type: 'string' } },
  title: { type: 'string', required: true },
  year: { type: 'number', required: true },
  venue: { type: 'string', required: true },
  doi: { type: 'string', required: true },
  url: { type: 'string', required: true },
  section: { type: 'string', required: true },
  pdfPageStart: { type: 'number', required: true },
  pdfPageEnd: { type: 'number', required: true },
  lineStart: { type: 'number', required: true },
  lineEnd: { type: 'number', required: true },
} as const

function referenceView(reference: PaperReferenceRecord) {
  return {
    id: reference.id, paperId: reference.paperId, ordinal: reference.ordinal, label: reference.label ?? '', rawText: reference.rawText,
    authors: [...reference.authors], title: reference.title ?? '', year: reference.year ?? 0, venue: reference.venue ?? '',
    doi: reference.doi ?? '', url: reference.url ?? '', section: reference.section,
    pdfPageStart: reference.pdfPageStart, pdfPageEnd: reference.pdfPageEnd, lineStart: reference.lineStart ?? 0, lineEnd: reference.lineEnd ?? 0,
  }
}

function renderReference(reference: ReturnType<typeof referenceView>): string {
  return `[${reference.ordinal}] ${reference.rawText}\nPDF pages: ${reference.pdfPageStart}-${reference.pdfPageEnd}; Markdown lines: ${reference.lineStart}-${reference.lineEnd}`
}

/** Registers read-only tools for bibliography entries extracted from parsed PDFs. */
export function registerReferenceTools(ctx: Context, { store: storePromise }: ReferenceToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'list_paper_references',
    description: 'List all bibliography references extracted from one parsed paper. Use this to discover cited works before researching related papers.',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'Owned parsed-paper id.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          references: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: referenceProperties } },
        },
      },
      render: (_args, value) => value.references.length === 0
        ? [{ type: 'text', text: `No extracted references were found for paper ${value.paperId}.` }]
        : [{ type: 'text', text: value.references.map(renderReference).join('\n\n') }],
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      return { paperId: args.paper_id, references: store.listPaperReferences(workspace, args.paper_id).map(referenceView) }
    },
    presentCall: args => ({ card: 'generic', title: 'List paper references', kind: 'read', rawInput: args.paper_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_paper_reference',
    description: 'Read one extracted bibliography reference by its ordinal number from a parsed paper. Call list_paper_references first when the ordinal is unknown.',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'Owned parsed-paper id.' },
      ordinal: { type: 'number', required: true, description: 'Reference number printed by the source paper, such as 1 or 12.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: referenceProperties },
      render: (_args, value) => [{ type: 'text', text: renderReference(value) }],
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      return referenceView(store.getPaperReference(workspace, args.paper_id, Math.trunc(args.ordinal)))
    },
    presentCall: args => ({ card: 'generic', title: `Read paper reference [${args.ordinal}]`, kind: 'read', rawInput: args.paper_id }),
  }))
}
