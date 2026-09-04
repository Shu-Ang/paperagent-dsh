/** Browser-safe durable diagnostics for one PaperAgent retrieval tool call. */

import type {} from '@deepseek-ai/dsh-session/types'

export type PaperRetrievalTraceStageKind = 'sqlite' | 'embedding' | 'elasticsearch' | 'fusion' | 'rerank' | 'final'
export type PaperRetrievalTraceStageStatus = 'completed' | 'skipped' | 'fallback' | 'failed'

export interface PaperRetrievalTraceCandidate {
  readonly sourceId: string
  readonly paperId: string
  readonly title: string
  readonly section: string
  readonly pdfPageStart: number
  readonly rank: number
  readonly score?: number
  readonly sqliteRank?: number
  readonly elasticRank?: number
  readonly elasticKeywordRank?: number
  readonly elasticVectorRank?: number
  readonly fusionScore?: number
  readonly rerankScore?: number
  readonly excerpt: string
}

export interface PaperRetrievalTraceStage {
  readonly kind: PaperRetrievalTraceStageKind
  readonly status: PaperRetrievalTraceStageStatus
  readonly durationMs: number
  readonly method?: 'fts' | 'bm25' | 'knn' | 'rrf' | 'dashscope-rerank'
  readonly reason?: string
  readonly candidates: readonly PaperRetrievalTraceCandidate[]
}

/** One bounded trace tied to the durable DSH tool/call identity. */
export interface PaperRetrievalTraceEventDataV1 {
  readonly version: 1
  readonly callId: string
  readonly turn: number
  readonly step: number
  readonly toolName: 'search_paper_library' | 'search_paper_elements' | 'search_paper_figures'
  readonly totalMs: number
  readonly query: {
    readonly text: string
    readonly limit: number
    readonly filters: Record<string, unknown>
  }
  readonly stages: readonly PaperRetrievalTraceStage[]
  readonly warnings: readonly string[]
}

/**
 * A future trace revision must never make its whole DSH Session unreadable.
 * It remains durable but is intentionally not interpreted by the current
 * plugin; the trajectory inspector can surface this bounded notice instead.
 */
export interface PaperRetrievalTraceUnsupportedEventData {
  readonly version: number
  readonly unsupported: true
  readonly callId?: string
}

export type PaperRetrievalTraceEventData = PaperRetrievalTraceEventDataV1 | PaperRetrievalTraceUnsupportedEventData

const STAGE_KINDS = new Set<PaperRetrievalTraceStageKind>(['sqlite', 'embedding', 'elasticsearch', 'fusion', 'rerank', 'final'])
const STAGE_STATUSES = new Set<PaperRetrievalTraceStageStatus>(['completed', 'skipped', 'fallback', 'failed'])
const METHODS = new Set(['fts', 'bm25', 'knn', 'rrf', 'dashscope-rerank'])

/** Strict decoder: malformed diagnostics never poison session-history replay. */
export function decodePaperRetrievalTraceEventData(value: unknown): PaperRetrievalTraceEventData {
  if (isRecord(value) && Number.isSafeInteger(value.version) && value.version !== 1) {
    return {
      version: value.version,
      unsupported: true,
      ...(typeof value.callId === 'string' && value.callId !== '' ? { callId: value.callId.slice(0, 256) } : {}),
    }
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.callId !== 'string' || value.callId === ''
    || !Number.isSafeInteger(value.turn) || !Number.isSafeInteger(value.step)
    || !['search_paper_library', 'search_paper_elements', 'search_paper_figures'].includes(String(value.toolName))
    || !finiteNonNegative(value.totalMs) || !isRecord(value.query) || typeof value.query.text !== 'string'
    || !Number.isSafeInteger(value.query.limit) || !isRecord(value.query.filters)
    || !Array.isArray(value.stages) || value.stages.length > 8
    || !Array.isArray(value.warnings) || value.warnings.length > 12) {
    throw new TypeError('invalid paperagent/retrieval-trace event payload')
  }
  const stages = value.stages.map(decodeStage)
  const warnings = value.warnings.map(warning => {
    if (typeof warning !== 'string' || warning.length > 300) throw new TypeError('invalid paper retrieval trace warning')
    return warning
  })
  return {
    version: 1,
    callId: value.callId,
    turn: value.turn,
    step: value.step,
    toolName: value.toolName as PaperRetrievalTraceEventDataV1['toolName'],
    totalMs: value.totalMs,
    query: { text: value.query.text.slice(0, 2_000), limit: value.query.limit, filters: { ...value.query.filters } },
    stages,
    warnings,
  }
}

function decodeStage(value: unknown): PaperRetrievalTraceStage {
  if (!isRecord(value) || typeof value.kind !== 'string' || !STAGE_KINDS.has(value.kind as PaperRetrievalTraceStageKind)
    || typeof value.status !== 'string' || !STAGE_STATUSES.has(value.status as PaperRetrievalTraceStageStatus)
    || !finiteNonNegative(value.durationMs) || !Array.isArray(value.candidates) || value.candidates.length > 30
    || (value.method !== undefined && (typeof value.method !== 'string' || !METHODS.has(value.method)))
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 300))) {
    throw new TypeError('invalid paper retrieval trace stage')
  }
  return {
    kind: value.kind as PaperRetrievalTraceStageKind,
    status: value.status as PaperRetrievalTraceStageStatus,
    durationMs: value.durationMs,
    ...(value.method === undefined ? {} : { method: value.method as 'fts' | 'bm25' | 'knn' | 'rrf' | 'dashscope-rerank' }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    candidates: value.candidates.map(decodeCandidate),
  }
}

function decodeCandidate(value: unknown): PaperRetrievalTraceCandidate {
  if (!isRecord(value) || typeof value.sourceId !== 'string' || typeof value.paperId !== 'string'
    || typeof value.title !== 'string' || typeof value.section !== 'string' || typeof value.excerpt !== 'string'
    || !Number.isSafeInteger(value.pdfPageStart) || !Number.isSafeInteger(value.rank)
    || value.excerpt.length > 300 || !finiteOptional(value.score) || !finiteOptional(value.sqliteRank)
    || !finiteOptional(value.elasticRank) || !finiteOptional(value.elasticKeywordRank)
    || !finiteOptional(value.elasticVectorRank) || !finiteOptional(value.fusionScore)
    || !finiteOptional(value.rerankScore)) {
    throw new TypeError('invalid paper retrieval trace candidate')
  }
  return {
    sourceId: value.sourceId, paperId: value.paperId, title: value.title, section: value.section,
    pdfPageStart: value.pdfPageStart, rank: value.rank, excerpt: value.excerpt,
    ...(value.score === undefined ? {} : { score: value.score as number }),
    ...(value.sqliteRank === undefined ? {} : { sqliteRank: value.sqliteRank as number }),
    ...(value.elasticRank === undefined ? {} : { elasticRank: value.elasticRank as number }),
    ...(value.elasticKeywordRank === undefined ? {} : { elasticKeywordRank: value.elasticKeywordRank as number }),
    ...(value.elasticVectorRank === undefined ? {} : { elasticVectorRank: value.elasticVectorRank as number }),
    ...(value.fusionScore === undefined ? {} : { fusionScore: value.fusionScore as number }),
    ...(value.rerankScore === undefined ? {} : { rerankScore: value.rerankScore as number }),
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finiteOptional(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'paperagent/retrieval-trace': PaperRetrievalTraceEventData
  }
}
