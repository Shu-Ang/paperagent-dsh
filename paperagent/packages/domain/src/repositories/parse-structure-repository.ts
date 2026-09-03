import type { DatabaseSync } from 'node:sqlite'
import type { PaperChunkElementPreview, PaperChunkPreview, PaperParseStructure, PaperRecord, PaperSectionNode } from '../models.ts'
import type { PaperChunkRow, PaperElementRow, PaperSectionRow } from '../rows.ts'
import { canonicalWorkspace } from '../paths.ts'

type PaperGetter = (workspacePath: string, paperId: string) => PaperRecord

interface ChunkElementPreviewRow extends PaperElementRow {
  chunk_id: string
  figure_id: string | null
}

/** Reads the active parsed section tree and complete child-chunk content. */
export function getPaperParseStructure(
  db: DatabaseSync,
  workspacePath: string,
  paperId: string,
  getPaper: PaperGetter,
): PaperParseStructure {
  const paper = getPaper(workspacePath, paperId)
  if (paper.parseStatus !== 'ready' || paper.parseRevision === null) {
    throw new Error('paper parse structure is available only for a ready parsed paper')
  }

  const workspace = canonicalWorkspace(paper.workspacePath)
  const sections = db.prepare(`
    SELECT * FROM paper_sections
    WHERE workspace_path = ? AND paper_id = ?
    ORDER BY reading_order ASC
  `).all(workspace, paper.id) as unknown as PaperSectionRow[]
  if (sections.length === 0) throw new Error('paper has no parsed section structure; reparse is required')

  const chunks = db.prepare(`
    SELECT c.*
    FROM paper_chunks c
    WHERE c.workspace_path = ? AND c.paper_id = ? AND COALESCE(c.chunk_type, 'child') = 'child'
    ORDER BY c.line_start ASC, c.sequence ASC, c.id ASC
  `).all(workspace, paper.id) as unknown as PaperChunkRow[]

  const elementRows = db.prepare(`
    SELECT ce.chunk_id, e.*,
      (SELECT f.id FROM paper_figures f
       WHERE f.element_id = e.id AND f.workspace_path = e.workspace_path AND f.paper_id = e.paper_id
       LIMIT 1) AS figure_id
    FROM paper_chunk_elements ce
    JOIN paper_elements e ON e.id = ce.element_id
    WHERE e.workspace_path = ? AND e.paper_id = ?
    ORDER BY e.reading_order ASC, e.id ASC
  `).all(workspace, paper.id) as unknown as ChunkElementPreviewRow[]
  const elementsByChunk = new Map<string, PaperChunkElementPreview[]>()
  for (const row of elementRows) {
    const elements = elementsByChunk.get(row.chunk_id) ?? []
    elements.push(toElementPreview(row))
    elementsByChunk.set(row.chunk_id, elements)
  }

  const nodes = new Map<string, MutableSectionNode>()
  for (const row of sections) {
    nodes.set(row.id, {
      id: row.id,
      title: row.title,
      path: row.path,
      level: row.level,
      parentId: row.parent_id,
      pdfPageStart: row.pdf_page_start,
      pdfPageEnd: row.pdf_page_end,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      chunkCount: 0,
      chunks: [],
      children: [],
      readingOrder: row.reading_order,
    })
  }

  const roots: MutableSectionNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  for (const node of nodes.values()) node.children.sort((left, right) => left.readingOrder - right.readingOrder)

  const documentRoot = [...nodes.values()].find(node => node.level === 0 && node.parentId === null)
  for (const row of chunks) {
    // Parser output normally carries the document-root section id. Keeping an
    // explicit root fallback prevents a malformed relation from hiding chunks
    // in the read-only visualization while preserving their original order.
    const node = row.section_id === null ? documentRoot : nodes.get(row.section_id) ?? documentRoot
    if (node === undefined) throw new Error(`paper chunk ${row.id} is not attached to a parsed section`)
    node.chunks.push(toChunkPreview(row, elementsByChunk.get(row.id) ?? []))
    node.chunkCount += 1
  }

  return {
    paperId: paper.id,
    title: paper.title,
    revisionId: paper.parseRevision,
    parsedAt: paper.parsedAt,
    sectionCount: sections.length,
    chunkCount: chunks.length,
    sections: roots.map(toSectionNode),
  }
}

interface MutableSectionNode {
  id: string
  title: string
  path: string
  level: number
  parentId: string | null
  pdfPageStart: number
  pdfPageEnd: number
  lineStart: number
  lineEnd: number
  chunkCount: number
  chunks: PaperChunkPreview[]
  children: MutableSectionNode[]
  readingOrder: number
}

function toChunkPreview(row: PaperChunkRow, elements: readonly PaperChunkElementPreview[]): PaperChunkPreview {
  return {
    id: row.id,
    sequence: row.sequence ?? 0,
    pdfPageStart: row.pdf_page_start,
    pdfPageEnd: row.pdf_page_end,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    charCount: row.content.length,
    content: row.content,
    elements,
  }
}

function toElementPreview(row: ChunkElementPreviewRow): PaperChunkElementPreview {
  return {
    id: row.id,
    elementType: row.element_type,
    pdfPageStart: row.pdf_page_start,
    pdfPageEnd: row.pdf_page_end,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    content: row.content,
    caption: row.caption,
    contentFormat: row.content_format,
    figureId: row.figure_id,
  }
}

function toSectionNode(node: MutableSectionNode): PaperSectionNode {
  return {
    id: node.id,
    title: node.title,
    path: node.path,
    level: node.level,
    parentId: node.parentId,
    pdfPageStart: node.pdfPageStart,
    pdfPageEnd: node.pdfPageEnd,
    lineStart: node.lineStart,
    lineEnd: node.lineEnd,
    chunkCount: node.chunkCount,
    chunks: node.chunks,
    children: node.children.map(toSectionNode),
  }
}
