import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PaperAgentStore } from '@paperagent/domain'
import { requireWorkspace } from './runtime.ts'

export interface LibraryToolDependencies {
  readonly store: Promise<PaperAgentStore>
}

/** Registers paper-library and bibliography read tools without owning plugin lifecycle. */
export function registerLibraryTools(ctx: Context, { store: storePromise }: LibraryToolDependencies): void {
  ctx.tools.register(defineTool({
    name: 'create_paper_library',
    description: 'Create a named paper library in the active research workspace.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short library name, such as Machine Learning.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Created paper library ${value.name} (${value.id}).` }],
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      const library = store.createLibrary({ workspacePath: workspace, name: args.name })
      return { id: library.id, name: library.name }
    },
    presentCall: args => ({ card: 'generic', title: `Create paper library: ${args.name}`, kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'list_paper_libraries',
    description: 'List the paper libraries in the active research workspace. Use this before choosing a library.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          libraries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.libraries.length === 0
          ? 'No paper libraries exist in this workspace yet.'
          : value.libraries.map(library => `${library.name} (${library.id})`).join('\n'),
      }],
    },
    async execute(_args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      return { libraries: store.listLibraries(workspace).map(library => ({ id: library.id, name: library.name })) }
    },
    presentCall: () => ({ card: 'generic', title: 'List paper libraries', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'list_papers',
    description: 'List papers in the active research workspace. Optionally limit the result to one paper library.',
    parameters: {
      library_id: { type: 'string', description: 'Optional paper library id.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          papers: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                parseStatus: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => value.papers.length === 0
        ? [{ type: 'text', text: 'No papers match this workspace or library.' }]
        : [{ type: 'text', text: value.papers.map(paper => `${paper.title} [${paper.parseStatus}] (${paper.id})`).join('\n') }],
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      return {
        papers: store.listPapers(workspace, args.library_id)
          .map(paper => ({ id: paper.id, title: paper.title, parseStatus: paper.parseStatus })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List papers', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'read_paper_bibliography',
    description: 'Read verified local BibTeX and citation keys for up to 20 papers in the active workspace. Use only before updating a user-selected LaTeX .bib file; this tool never writes project files.',
    parameters: {
      paper_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'One to twenty PaperAgent paper ids from the active workspace.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                paperId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                citationKey: { type: 'string', required: true },
                bibtex: { type: 'string', required: true },
                doi: { type: 'string', required: true },
                sourceAdapter: { type: 'string', required: true },
                metadataStatus: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.map(entry => {
          const header = `${entry.title} (${entry.paperId}) · ${entry.metadataStatus}`
          return entry.metadataStatus === 'ready'
            ? `${header}\nCitation key: ${entry.citationKey}\nBibTeX:\n${entry.bibtex}`
            : `${header}\nNo safe LaTeX citation can be inserted until this bibliography entry is corrected.`
        }).join('\n\n'),
      }],
    },
    async execute(args, execution) {
      const store = await storePromise
      const workspace = requireWorkspace(execution.agent?.session.header.cwd)
      return {
        entries: store.readPaperBibliography(workspace, args.paper_ids).map(entry => ({
          paperId: entry.paperId,
          title: entry.title,
          citationKey: entry.citationKey ?? '',
          bibtex: entry.bibtex ?? '',
          doi: entry.doi ?? '',
          sourceAdapter: entry.sourceAdapter ?? '',
          metadataStatus: entry.metadataStatus,
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read paper bibliography', kind: 'read' }),
  }))

}
