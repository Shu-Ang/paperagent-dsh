/** Durable validation of PaperAgent citation markers written by the model. */

import type { Context } from '@deepseek-ai/cordis'
import type { PaperCitationElementType, PaperCitationEvidence, PaperCitationReference, PaperCitationSnapshot } from '@paperagent/contracts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

interface CitationToolMeta {
  readonly kind: 'paper-citations'
  readonly evidence: readonly PaperCitationEvidence[]
}

/**
 * Accept the standard bare marker and the legacy inline-code form. Neither
 * form is trusted until it matches a same-turn tool result.
 */
const MARKER = /`?paperagent-cite:([A-Za-z0-9_-]{1,128})`?/g
const EXCERPT_LIMIT = 1_200

/**
 * Records only citations returned by PaperAgent retrieval tools in the same
 * turn. The LLM controls marker placement, never source coordinates.
 */
export function installPaperCitationRecorder(ctx: Context): void {
  // Sessions are owned by DSH's application context, while PaperAgent is
  // mounted as a loader child. Observe the durable feed globally so Cordis
  // scope filtering cannot hide assistant finalization events from this
  // cross-cutting validator.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'assistant/message') return
    const markers = citationMarkersInAssistantMessage(event)
    if (markers.length === 0) return
    const workspace = session.header.cwd
    if (workspace === undefined || workspace.trim() === '') return
    const available = citationsForTurn(session, event.data.turn)
    const citations: PaperCitationSnapshot[] = []
    const references: PaperCitationReference[] = []
    const ordinals = new Map<string, number>()
    for (const marker of markers) {
      const candidate = available.get(marker.evidenceId)
      if (candidate === undefined) continue
      let ordinal = ordinals.get(candidate.evidenceId)
      if (ordinal === undefined) {
        ordinal = citations.length + 1
        ordinals.set(candidate.evidenceId, ordinal)
        // The evidence was produced by a Host tool in this same workspace and
        // turn. The PDF route independently rechecks paper ownership on click,
        // so a concurrent deletion can only degrade to a controlled failure.
        citations.push({ ...candidate.citation })
      }
      references.push({
        evidenceId: candidate.evidenceId,
        citationId: candidate.citation.citationId,
        ordinal,
        blockIndex: marker.blockIndex,
        markerStart: marker.markerStart,
        markerEnd: marker.markerEnd,
      })
    }
    if (references.length === 0) return
    const record = {
      version: 1 as const,
      turn: event.data.turn,
      assistantMessageId: String(event.data.message.id),
      assistantSeq: event.seq,
      references,
      citations,
    }
    // Session observers run while `Session.append()` is still notifying the
    // current event. Appending synchronously here is deliberately rejected as
    // re-entrant by DSH, and observer errors are contained, which previously
    // made the missing record look like a frontend failure. Queue one
    // microtask so this append runs after the message notification commits,
    // while remaining before the agent advances the event loop.
    queueMicrotask(() => {
      try {
        session.append('paperagent/citations', record)
      } catch (error) {
        ctx.logger.warn(`paperagent: could not record validated citations: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }, { global: true })
}

/** A JSON-only `presentationMeta` value shared by both local text retrieval tools. */
export function paperCitationPresentationMeta(evidence: readonly PaperCitationEvidence[]) {
  return {
    kind: 'paper-citations',
    evidence: evidence.map(item => ({ evidenceId: item.evidenceId, citation: { ...item.citation } })),
  }
}

function citationMarkersInAssistantMessage(event: Extract<SessionEvent, { type: 'assistant/message' }>): Array<{
  readonly evidenceId: string
  readonly blockIndex: number
  readonly markerStart: number
  readonly markerEnd: number
}> {
  const markers: Array<{ readonly evidenceId: string; readonly blockIndex: number; readonly markerStart: number; readonly markerEnd: number }> = []
  for (const [blockIndex, block] of event.data.message.content.entries()) {
    if (block.type !== 'text') continue
    for (const match of block.text.matchAll(MARKER)) {
      const evidenceId = match[1]
      if (evidenceId !== undefined && match.index !== undefined) {
        markers.push({ evidenceId, blockIndex, markerStart: match.index, markerEnd: match.index + match[0].length })
      }
    }
  }
  return markers
}

function citationsForTurn(session: Session, turn: number): Map<string, PaperCitationEvidence> {
  const citations = new Map<string, PaperCitationEvidence>()
  for (const event of session.events) {
    if (event.type !== 'tool/result' || event.data.turn !== turn) continue
    const meta = readCitationToolMeta(event.data.meta)
    if (meta === undefined) continue
    for (const item of meta.evidence) citations.set(item.evidenceId, item)
  }
  return citations
}

function readCitationToolMeta(value: unknown): CitationToolMeta | undefined {
  if (!isRecord(value) || value.kind !== 'paper-citations' || !Array.isArray(value.evidence)) return undefined
  const evidence = value.evidence.map(readEvidence).filter((item): item is PaperCitationEvidence => item !== undefined)
  return evidence.length === value.evidence.length ? { kind: 'paper-citations', evidence } : undefined
}

function readEvidence(value: unknown): PaperCitationEvidence | undefined {
  if (!isRecord(value) || typeof value.evidenceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.evidenceId)) return undefined
  const citation = readCitation(value.citation)
  return citation === undefined ? undefined : { evidenceId: value.evidenceId, citation }
}

function readCitation(value: unknown): PaperCitationSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const strings = ['citationId', 'paperId', 'title', 'section', 'excerpt'] as const
  const numbers = ['pdfPageStart', 'pdfPageEnd', 'markdownLineStart', 'markdownLineEnd'] as const
  if (strings.some(key => typeof value[key] !== 'string') || numbers.some(key => !Number.isSafeInteger(value[key]))) return undefined
  return {
    citationId: value.citationId as string, paperId: value.paperId as string, title: value.title as string, section: value.section as string,
    ...(typeof value.elementType === 'string' ? { elementType: value.elementType as PaperCitationElementType } : {}),
    ...(typeof value.elementLabel === 'string' ? { elementLabel: value.elementLabel as string } : {}),
    pdfPageStart: value.pdfPageStart as number, pdfPageEnd: value.pdfPageEnd as number,
    markdownLineStart: value.markdownLineStart as number, markdownLineEnd: value.markdownLineEnd as number,
    excerpt: (value.excerpt as string).slice(0, EXCERPT_LIMIT),
    ...(typeof value.pdfAvailable === 'boolean' ? { pdfAvailable: value.pdfAvailable } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
