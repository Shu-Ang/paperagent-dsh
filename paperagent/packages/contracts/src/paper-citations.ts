/** Browser-safe, durable PaperAgent citation snapshots. */

export type PaperCitationElementType = 'text' | 'figure' | 'table' | 'equation' | 'code' | 'list'

import type {} from '@deepseek-ai/dsh-session/types'

/** A validated local-paper source rendered beneath one assistant answer. */
export interface PaperCitationSnapshot {
  /** Chunk or exact-match identity returned by a PaperAgent retrieval tool. */
  readonly citationId: string
  readonly paperId: string
  readonly title: string
  readonly section: string
  readonly elementType?: PaperCitationElementType
  readonly elementLabel?: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly markdownLineStart: number
  readonly markdownLineEnd: number
  /** Bounded source text retained for historical citation display. */
  readonly excerpt: string
  /** Whether the owned paper had a local original PDF when the answer settled. */
  readonly pdfAvailable?: boolean
}

/** One model-visible, turn-scoped handle for a Host-owned citation snapshot. */
export interface PaperCitationEvidence {
  /** Opaque short handle the model may place in its final inline-code token. */
  readonly evidenceId: string
  readonly citation: PaperCitationSnapshot
}

/** One validated citation-token occurrence inside a finalized assistant text block. */
export interface PaperCitationReference {
  readonly evidenceId: string
  readonly citationId: string
  /** One-based display number assigned by first occurrence in the answer. */
  readonly ordinal: number
  readonly blockIndex: number
  readonly markerStart: number
  readonly markerEnd: number
}

/** One immutable citation set associated with a finalized assistant message. */
export interface PaperCitationsEventData {
  readonly version: 1
  readonly turn: number
  readonly assistantMessageId: string
  readonly assistantSeq: number
  /** Every valid inline token occurrence, in assistant-text order. */
  readonly references: readonly PaperCitationReference[]
  /** Unique snapshots in the same first-occurrence order as {@link references}. */
  readonly citations: readonly PaperCitationSnapshot[]
}

/** Runtime decoder used by DSH session persistence before replaying citations. */
export function decodePaperCitationsEventData(value: unknown): PaperCitationsEventData {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.turn)
    || typeof value.assistantMessageId !== 'string' || !Number.isSafeInteger(value.assistantSeq)
    || !Array.isArray(value.references) || !Array.isArray(value.citations)) {
    throw new TypeError('invalid paperagent/citations event payload')
  }
  const citations = value.citations.map(decodeCitationSnapshot)
  const citationIds = new Set(citations.map(item => item.citationId))
  const references = value.references.map(item => decodeCitationReference(item, citationIds))
  return { version: 1, turn: value.turn, assistantMessageId: value.assistantMessageId, assistantSeq: value.assistantSeq, references, citations }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeCitationReference(value: unknown, citationIds: ReadonlySet<string>): PaperCitationReference {
  if (!isRecord(value) || typeof value.evidenceId !== 'string' || typeof value.citationId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.evidenceId) || !citationIds.has(value.citationId)
    || !Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 1
    || !Number.isSafeInteger(value.blockIndex) || (value.blockIndex as number) < 0
    || !Number.isSafeInteger(value.markerStart) || (value.markerStart as number) < 0
    || !Number.isSafeInteger(value.markerEnd) || (value.markerEnd as number) < value.markerStart) throw new TypeError('invalid paper citation reference')
  return {
    evidenceId: value.evidenceId, citationId: value.citationId, ordinal: value.ordinal,
    blockIndex: value.blockIndex, markerStart: value.markerStart, markerEnd: value.markerEnd,
  }
}

function decodeCitationSnapshot(value: unknown): PaperCitationSnapshot {
  if (!isRecord(value) || typeof value.citationId !== 'string' || typeof value.paperId !== 'string'
    || typeof value.title !== 'string' || typeof value.section !== 'string'
    || !Number.isSafeInteger(value.pdfPageStart) || !Number.isSafeInteger(value.pdfPageEnd)
    || !Number.isSafeInteger(value.markdownLineStart) || !Number.isSafeInteger(value.markdownLineEnd)
    || typeof value.excerpt !== 'string') throw new TypeError('invalid paper citation snapshot')
  if (value.citationId.trim() === '' || value.paperId.trim() === '' || value.title.trim() === '' || value.section.trim() === '') throw new TypeError('invalid paper citation identity')
  if (value.pdfPageStart < 0 || value.pdfPageEnd < value.pdfPageStart || value.markdownLineStart < 0 || value.markdownLineEnd < value.markdownLineStart) throw new TypeError('invalid paper citation coordinates')
  if (value.elementType !== undefined && !['text', 'figure', 'table', 'equation', 'code', 'list'].includes(value.elementType)) throw new TypeError('invalid paper citation element type')
  if (value.elementLabel !== undefined && typeof value.elementLabel !== 'string') throw new TypeError('invalid paper citation element label')
  if (value.pdfAvailable !== undefined && typeof value.pdfAvailable !== 'boolean') throw new TypeError('invalid paper citation PDF availability')
  return {
    citationId: value.citationId,
    paperId: value.paperId,
    title: value.title,
    section: value.section,
    ...(value.elementType === undefined ? {} : { elementType: value.elementType as PaperCitationElementType }),
    ...(value.elementLabel === undefined ? {} : { elementLabel: value.elementLabel }),
    pdfPageStart: value.pdfPageStart,
    pdfPageEnd: value.pdfPageEnd,
    markdownLineStart: value.markdownLineStart,
    markdownLineEnd: value.markdownLineEnd,
    excerpt: value.excerpt.slice(0, 1_200),
    ...(value.pdfAvailable === undefined ? {} : { pdfAvailable: value.pdfAvailable }),
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Validated local-paper citations rendered directly after an assistant answer. */
    'paperagent/citations': PaperCitationsEventData
  }
}
