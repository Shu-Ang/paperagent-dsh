import type { EmbeddingContextReason, PaperEmbeddingSource, PaperElementRecord, PaperFigureRecord, PaperChunkRecord, PaperRecord } from './models.ts'

export interface EmbeddingProjectionInput {
  readonly paper: PaperRecord
  readonly chunks: readonly PaperChunkRecord[]
  readonly elements: readonly PaperElementRecord[]
  readonly figures: readonly PaperFigureRecord[]
  /** Parser-confirmed chunk/element membership from source-map construction. */
  readonly linkedChunkIdsByElement: ReadonlyMap<string, readonly string[]>
}

/**
 * Builds provider-ready text in logical document order, never by PDF geometry.
 * Figure/table contexts are explainable: caption, explicit in-text references,
 * then same-section logical neighbours, with page distance only as a tie-break.
 */
export function buildEmbeddingSources(input: EmbeddingProjectionInput): PaperEmbeddingSource[] {
  const revision = input.paper.parseRevision
  if (revision === null) return []
  const chunks = [...input.chunks].sort((left, right) => left.lineStart - right.lineStart || left.id.localeCompare(right.id))
  const figuresByElement = new Map(input.figures.filter(figure => figure.elementId !== null).map(figure => [figure.elementId as string, figure]))
  const sources: PaperEmbeddingSource[] = chunks.map(chunk => ({
    sourceId: `chunk:${chunk.id}`,
    kind: 'chunk', paperId: input.paper.id, title: input.paper.title, workspacePath: input.paper.workspacePath, libraryId: input.paper.libraryId,
    parseRevision: revision, section: chunk.section, pdfPageStart: chunk.pdfPageStart, pdfPageEnd: chunk.pdfPageEnd,
    text: labelled([['Section', chunk.section], ['Text', chunk.content]]), contextChunkIds: [], contextReason: 'none',
  }))
  for (const element of [...input.elements].sort((left, right) => left.readingOrder - right.readingOrder || left.id.localeCompare(right.id))) {
    const figure = figuresByElement.get(element.id)
    const context = contextForElement(element, chunks, input.linkedChunkIdsByElement.get(element.id) ?? [], figure?.figureLabel ?? null)
    const fields: Array<readonly [string, string]> = [
      ['Type', element.elementType], ['Section', element.section],
      ...(element.caption === null || element.caption.trim() === '' ? [] : [['Caption', element.caption] as const]),
      ...element.elementType === 'table' ? [['Table content', element.content] as const] : [],
      ...element.elementType === 'equation' ? [['Equation', element.content] as const] : [],
      ...element.elementType !== 'table' && element.elementType !== 'equation' ? [['Content', element.content] as const] : [],
      ...figure?.visionDescription === undefined || figure.visionDescription === null || figure.visionDescription.trim() === ''
        ? [] : [['Visual description', figure.visionDescription] as const],
      ...context.explanation === '' ? [] : [['In-text explanation', context.explanation] as const],
      ...context.neighbours === '' ? [] : [['Local context', context.neighbours] as const],
    ]
    sources.push({
      sourceId: `element:${element.id}`,
      kind: 'element', paperId: input.paper.id, title: input.paper.title, workspacePath: input.paper.workspacePath, libraryId: input.paper.libraryId,
      parseRevision: revision, section: element.section, pdfPageStart: element.pdfPageStart, pdfPageEnd: element.pdfPageEnd,
      elementType: element.elementType, ...(element.caption === null || element.caption.trim() === '' ? {} : { caption: element.caption }),
      text: labelled(fields), contextChunkIds: context.chunkIds, contextReason: context.reason,
      ...(figure === undefined ? {} : { image: { relativePath: figure.relativePath, mimeType: figure.mimeType } }),
    })
  }
  return sources
}

function contextForElement(element: PaperElementRecord, chunks: readonly PaperChunkRecord[], linkedIds: readonly string[], label: string | null) {
  const inSection = chunks.filter(chunk => chunk.section === element.section)
  const linked = inSection.filter(chunk => linkedIds.includes(chunk.id))
  const referenced = label === null ? [] : inSection.filter(chunk => labelPattern(label).test(chunk.content))
  const explicit = referenced.length > 0 ? referenced : linked
  if (explicit.length > 0) {
    const first = explicit[0] as PaperChunkRecord
    const index = inSection.findIndex(chunk => chunk.id === first.id)
    const nearby = [inSection[index - 1], inSection[index + 1]].filter((chunk): chunk is PaperChunkRecord => chunk !== undefined)
    return { reason: 'in_text_reference' as const, chunkIds: [first.id, ...nearby.map(chunk => chunk.id)], explanation: first.content, neighbours: nearby.map(chunk => chunk.content).join('\n\n') }
  }
  const logical = inSection
    .filter(chunk => element.lineStart !== null)
    .sort((left, right) => Math.abs(left.lineStart - (element.lineStart as number)) - Math.abs(right.lineStart - (element.lineStart as number)))
    .slice(0, 2)
  if (logical.length > 0) return { reason: 'logical_neighbor' as const, chunkIds: logical.map(chunk => chunk.id), explanation: '', neighbours: logical.map(chunk => chunk.content).join('\n\n') }
  const page = inSection
    .sort((left, right) => pageDistance(left, element) - pageDistance(right, element))
    .slice(0, 2)
  if (page.length > 0) return { reason: 'page_fallback' as const, chunkIds: page.map(chunk => chunk.id), explanation: '', neighbours: page.map(chunk => chunk.content).join('\n\n') }
  return { reason: 'none' as EmbeddingContextReason, chunkIds: [], explanation: '', neighbours: '' }
}

function labelPattern(label: string): RegExp {
  const value = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(value, 'i')
}

function pageDistance(chunk: PaperChunkRecord, element: PaperElementRecord): number {
  if (chunk.pdfPageStart <= element.pdfPageEnd && chunk.pdfPageEnd >= element.pdfPageStart) return 0
  return Math.min(Math.abs(chunk.pdfPageStart - element.pdfPageEnd), Math.abs(chunk.pdfPageEnd - element.pdfPageStart))
}

function labelled(fields: readonly (readonly [string, string])[]): string {
  return fields.filter(([, value]) => value.trim() !== '').map(([name, value]) => `[${name}]\n${value.trim()}`).join('\n\n')
}
