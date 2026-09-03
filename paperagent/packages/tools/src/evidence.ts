import { relative, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PaperCitationElementType } from '@paperagent/contracts'

export function nextEvidenceIds(execution: ToolRunContext, count: number): string[] {
  if (count === 0) return []
  const session = execution.agent?.session
  if (session === undefined) throw new Error('PaperAgent evidence tools require an active DSH agent session')
  let turn: number | undefined
  for (const event of session.events) {
    if (event.type === 'tool/call' && event.data.callId === execution.callId) {
      turn = event.data.turn
      break
    }
  }
  if (turn === undefined) throw new Error('PaperAgent evidence tool call is missing from the active session log')
  let maximum = 0
  for (const event of session.events) {
    if (event.type !== 'tool/result' || event.data.turn !== turn) continue
    const meta = event.data.meta
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue
    const record = meta as { kind?: unknown; evidence?: unknown }
    if (record.kind !== 'paper-citations' || !Array.isArray(record.evidence)) continue
    for (const item of record.evidence) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const evidenceId = (item as { evidenceId?: unknown }).evidenceId
      if (typeof evidenceId !== 'string') continue
      const match = /^E(\d+)$/.exec(evidenceId)
      if (match?.[1] !== undefined) maximum = Math.max(maximum, Number(match[1]))
    }
  }
  return Array.from({ length: count }, (_unused, index) => `E${maximum + index + 1}`)
}

export function workspaceFilePath(workspace: string, sourcePath: string): string {
  const resolvedWorkspace = resolve(workspace)
  const filePath = resolve(resolvedWorkspace, sourcePath)
  const pathFromWorkspace = relative(resolvedWorkspace, filePath)
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith('..\\') || pathFromWorkspace.startsWith('../')) {
    throw new Error('paper source must be inside the active workspace')
  }
  return filePath
}

export function toCitationEvidence(citation: {
  readonly evidenceId: string
  readonly id: string; readonly paperId: string; readonly title: string; readonly section: string
  readonly pdfPageStart: number; readonly pdfPageEnd: number; readonly lineStart: number; readonly lineEnd: number; readonly excerpt: string
  readonly elementType?: string; readonly elementLabel?: string | null
}) {
  const elementType = citation.elementType !== undefined && ['text', 'figure', 'table', 'equation', 'code', 'list'].includes(citation.elementType)
    ? citation.elementType as PaperCitationElementType
    : undefined
  return {
    evidenceId: citation.evidenceId,
    citation: {
      citationId: citation.id,
      paperId: citation.paperId,
      title: citation.title,
      section: citation.section,
      ...(elementType === undefined ? {} : { elementType }),
      ...(citation.elementLabel === undefined || citation.elementLabel === null ? {} : { elementLabel: citation.elementLabel }),
      pdfPageStart: citation.pdfPageStart,
      pdfPageEnd: citation.pdfPageEnd,
      markdownLineStart: citation.lineStart,
      markdownLineEnd: citation.lineEnd,
      excerpt: citation.excerpt,
    },
  }
}

export function toFigureCitationEvidence(figure: {
  readonly evidenceId: string
  readonly id: string; readonly paperId: string; readonly title: string; readonly figureLabel: string; readonly sectionTitle: string
  readonly pdfPage: number; readonly rawCaption: string; readonly visionDescription: string
}) {
  const figureName = figure.figureLabel === '' ? 'Figure' : figure.figureLabel
  return {
    evidenceId: figure.evidenceId,
    citation: {
      citationId: figure.id,
      paperId: figure.paperId,
      title: figure.title,
      section: `${figureName} · ${figure.sectionTitle}`,
      pdfPageStart: figure.pdfPage,
      pdfPageEnd: figure.pdfPage,
      markdownLineStart: 0,
      markdownLineEnd: 0,
      excerpt: [figure.rawCaption, figure.visionDescription === '' ? '' : `Visual-model description: ${figure.visionDescription}`].filter(Boolean).join('\n').slice(0, 1_200),
    },
  }
}
