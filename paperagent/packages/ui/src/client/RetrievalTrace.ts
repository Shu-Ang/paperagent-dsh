/** Session-scoped RAG trace projection owned entirely by the PaperAgent plugin. */

import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationTimelineSnapshot,
  ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode, ConversationViewRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PaperRetrievalTraceEventData } from '@paperagent/contracts'

export interface PaperAgentRetrievalViewNode extends ConversationViewNode {
  readonly target: 'paperagent-retrieval'
  readonly anchorSeq: number
  readonly time: number
  readonly data: PaperRetrievalTraceEventData
}

export interface PaperAgentRetrievalRun {
  readonly seq: number
  readonly time: number
  readonly data: PaperRetrievalTraceEventData
}

export interface PaperAgentRetrievalSnapshot {
  readonly runs: readonly PaperAgentRetrievalRun[]
}

const EMPTY_RUNS: readonly PaperAgentRetrievalRun[] = []
export const EMPTY_PAPER_AGENT_RETRIEVAL_SNAPSHOT: PaperAgentRetrievalSnapshot = { runs: EMPTY_RUNS }

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    'paperagent-retrieval': PaperAgentRetrievalSnapshot
  }
}

function retrievalNode(
  context: ConversationNodeContext<PaperRetrievalTraceEventData>,
  anchorSeq: number,
  data: PaperRetrievalTraceEventData,
): PaperAgentRetrievalViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'paperagent-retrieval',
    anchorSeq,
    time: context.start?.event.time ?? 0,
    data,
  }
}

/** Materializes one durable retrieval trace per tool call. */
export function createRetrievalTraceDefinition(): ConversationNodeDefinition<PaperRetrievalTraceEventData> {
  return {
    kind: 'paperagent-retrieval-trace',
    target: 'paperagent-retrieval',
    match: event => event.type === 'paperagent/retrieval-trace' && event.data.callId !== undefined
      ? { id: event.data.callId, role: 'start' }
      : null,
    start: (_context, match) => {
      if (match.event.type !== 'paperagent/retrieval-trace') {
        throw new Error('paperagent retrieval trace start requires a paperagent/retrieval-trace event')
      }
      return match.event.data
    },
    update: context => context.state,
    buildViewNode: context => {
      const data = context.state
      const anchorSeq = context.start?.event.seq
      return data === undefined || anchorSeq === undefined ? null : retrievalNode(context, anchorSeq, data)
    },
  }
}

class PaperAgentRetrievalSnapshotBuilder implements ConversationViewBuilder<
  PaperAgentRetrievalViewNode,
  PaperAgentRetrievalSnapshot
> {
  private readonly nodes = new Map<string, PaperAgentRetrievalViewNode>()
  readonly empty = EMPTY_PAPER_AGENT_RETRIEVAL_SNAPSHOT

  replace(input: { readonly nodes: readonly PaperAgentRetrievalViewNode[]; readonly timeline: ConversationTimelineSnapshot }): PaperAgentRetrievalSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly PaperAgentRetrievalViewNode[]; readonly timeline: ConversationTimelineSnapshot }): PaperAgentRetrievalSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): PaperAgentRetrievalSnapshot {
    const runs = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
      .map(node => ({ seq: node.anchorSeq, time: node.time, data: node.data }))
    return runs.length === 0 ? EMPTY_PAPER_AGENT_RETRIEVAL_SNAPSHOT : { runs }
  }
}

const retrievalViewDefinition: ConversationViewDefinition<
  PaperAgentRetrievalViewNode,
  PaperAgentRetrievalSnapshot
> = {
  target: 'paperagent-retrieval',
  create: () => new PaperAgentRetrievalSnapshotBuilder(),
}

export function registerPaperAgentRetrievalView(ctx: { readonly conversationViews: ConversationViewRegistry }): void {
  ctx.conversationViews.register(retrievalViewDefinition)
}
