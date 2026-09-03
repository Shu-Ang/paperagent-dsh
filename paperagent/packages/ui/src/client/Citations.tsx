/** Conversation projection for PaperAgent's validated durable citations. */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatInlineCodeMentionProvider } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PaperCitationsEventData } from '@paperagent/contracts'
import type { PdfPreview } from './Pdf.tsx'

export interface CitationChatData extends PaperCitationsEventData {}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** Validated PaperAgent evidence for the closing assistant message in one turn. */
    'paperagent-citations': CitationChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'paperagent-citations': CitationChatData
  }
}

/** One immutable citation row is placed directly after its source assistant answer. */
export const citationDefinition: ConversationNodeDefinition<CitationChatData> = {
  kind: 'paperagent-citations',
  match: event => event.type === 'paperagent/citations'
    ? { id: String(event.data.assistantSeq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'paperagent/citations') throw new Error('paperagent citation start requires a paperagent/citations event')
    return match.event.data
  },
  update: context => context.state,
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: 'paperagent-citations',
      value: context.state,
    },
}

/**
 * DSH owns the visual treatment of inline mentions. This module owns only the
 * PaperAgent-specific evidence validation, ordinal and PDF jump behavior.
 */
export function createCitationMentionProvider(preview: PdfPreview): ChatInlineCodeMentionProvider {
  return {
    forClosing(owner) {
      const data = owner.turn.data.get('paperagent-citations')
      if (data === undefined || data.assistantSeq !== owner.seq) return undefined
      const citationById = new Map(data.citations.map(citation => [citation.citationId, citation]))
      const referenceByEvidenceId = new Map(data.references.map(reference => [reference.evidenceId, reference]))
      const resolveCitation = (value: string) => {
        const evidenceId = value.startsWith('paperagent-cite:') ? value.slice('paperagent-cite:'.length) : undefined
        if (evidenceId === undefined || evidenceId === '') return undefined
        const reference = referenceByEvidenceId.get(evidenceId)
        const citation = reference === undefined ? undefined : citationById.get(reference.citationId)
        if (citation === undefined || reference === undefined) return undefined
        if (citation.pdfAvailable === false) return {
          open: () => undefined,
          text: `[${reference.ordinal}]`,
          title: `${citation.title}：未上传原始 PDF，无法预览`,
          label: `引用 ${reference.ordinal}：原始 PDF 不可用`,
          unavailable: true,
        }
        const page = citation.pdfPageStart > 0 ? citation.pdfPageStart : 1
        return {
          text: `[${reference.ordinal}]`,
          title: `${citation.title} · ${citation.section}${citation.pdfPageStart > 0 ? ` · PDF 第 ${citation.pdfPageStart} 页` : ''}`,
          label: `打开引用 ${reference.ordinal}：${citation.title}`,
          open: () => preview.open(citation.paperId, page),
        }
      }
      return {
        resolve: resolveCitation,
        resolveText(value) {
          const marker = /(^|[^A-Za-z0-9_-])(paperagent-cite:([A-Za-z0-9_-]{1,128}))(?=$|[^A-Za-z0-9_-])/g
          const matches = []
          for (const match of value.matchAll(marker)) {
            const token = match[2]
            const prefix = match[1] ?? ''
            const index = match.index
            if (token === undefined || index === undefined) continue
            const mention = resolveCitation(token)
            if (mention === undefined) continue
            const start = index + prefix.length
            matches.push({ start, end: start + token.length, mention })
          }
          return matches
        },
      }
    },
  }
}
