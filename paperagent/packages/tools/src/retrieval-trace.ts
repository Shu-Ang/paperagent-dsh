/** Per-tool-call RAG diagnostics, durable in the owning DSH session only. */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PaperRetrievalTraceEventDataV1 } from '@paperagent/contracts'
import type { RetrievalTraceSink, RetrievalTraceStage } from '@paperagent/retrieval'

const MAX_STAGES = 8

export class PaperRetrievalTraceCollector implements RetrievalTraceSink {
  private readonly startedAt = Date.now()
  private readonly values: RetrievalTraceStage[] = []

  stage(stage: RetrievalTraceStage): void {
    if (this.values.length >= MAX_STAGES) return
    this.values.push({
      ...stage,
      durationMs: Math.max(0, Math.trunc(stage.durationMs)),
      ...(stage.reason === undefined ? {} : { reason: redact(stage.reason).slice(0, 300) }),
      candidates: stage.candidates.slice(0, 30).map(candidate => ({
        ...candidate,
        // Candidate text comes from local papers, but it can still contain a
        // copied credential. Durable diagnostics must not become a bypass for
        // the normal tool-output redaction boundary.
        excerpt: redact(candidate.excerpt).slice(0, 300),
      })),
    })
  }

  record(execution: ToolRunContext, input: {
    readonly toolName: PaperRetrievalTraceEventDataV1['toolName']
    readonly query: string
    readonly limit: number
    readonly filters: Record<string, unknown>
  }): void {
    const session = execution.agent?.session
    if (session === undefined) return
    const call = session.events.find(event => event.type === 'tool/call' && event.data.callId === execution.callId)
    if (call === undefined || call.type !== 'tool/call') return
    const record: PaperRetrievalTraceEventDataV1 = {
      version: 1,
      callId: String(execution.callId),
      turn: call.data.turn,
      step: call.data.step,
      toolName: input.toolName,
      totalMs: Math.max(0, Date.now() - this.startedAt),
      query: { text: input.query.slice(0, 2_000), limit: Math.min(Math.max(Math.trunc(input.limit), 1), 20), filters: input.filters },
      stages: this.values,
      warnings: [],
    }
    // Tool execution is not a session-event observer; this is a normal durable
    // append, unlike citation finalization which must defer out of observer re-entry.
    session.append('paperagent/retrieval-trace', record)
  }
}

function redact(value: string): string {
  return value.replace(/(ApiKey|Bearer)\s+[^\s]+/gi, '$1 [redacted]')
}
