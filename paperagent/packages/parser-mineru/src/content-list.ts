import type { PaperElementContentFormat, PaperElementType } from '@paperagent/domain'
import { findArchiveJson } from './archive.ts'

export interface ContentBlock {
  readonly type: string
  readonly elementType: PaperElementType | 'text'
  readonly text: string
  readonly caption?: string
  readonly contentFormat: PaperElementContentFormat
  readonly page: number
  readonly headingLevel?: number
  readonly readingOrder: number
  readonly imagePath?: string
  elementId?: string
}

export function parseContentList(files: ReadonlyMap<string, Uint8Array>): readonly ContentBlock[] {
  const v2 = findArchiveJson(files, /(?:^|\/)(?:[^/]+_)?content_list_v2\.json$/i)
  if (v2 !== undefined) return parseContentListV2(v2)
  const legacy = findArchiveJson(files, /(?:^|\/)(?:[^/]+_)?content_list\.json$/i)
  if (legacy !== undefined) return parseContentListLegacy(legacy)
  throw new Error('MinerU result archive is missing content_list_v2.json or content_list.json')
}

function parseContentListV2(value: unknown): readonly ContentBlock[] {
  if (!Array.isArray(value)) throw new Error('MinerU content_list_v2.json must be an array of pages')
  const blocks: ContentBlock[] = []
  let readingOrder = 0
  for (let pageIndex = 0; pageIndex < value.length; pageIndex += 1) {
    const page = value[pageIndex]
    if (!Array.isArray(page)) continue
    for (const item of page) {
      const recordItem = record(item)
      const type = stringValue(recordItem.type)
      if (type === undefined) continue
      const imagePath = imagePathFrom(recordItem)
      const details = contentDetailsV2(recordItem.content, type, imagePath)
      const titleLevel = type === 'title' ? numberValue(record(recordItem.content).level) ?? 1 : undefined
      blocks.push({ type, elementType: normalizeElementType(type), text: details.text, ...(details.caption === undefined ? {} : { caption: details.caption }), contentFormat: details.contentFormat, page: pageIndex + 1, readingOrder: readingOrder += 1, ...(titleLevel === undefined ? {} : { headingLevel: titleLevel }), ...(imagePath === undefined ? {} : { imagePath }) })
    }
  }
  return blocks
}

function parseContentListLegacy(value: unknown): readonly ContentBlock[] {
  if (!Array.isArray(value)) throw new Error('MinerU content_list.json must be an array')
  const blocks: ContentBlock[] = []
  let readingOrder = 0
  for (const item of value) {
    const recordItem = record(item)
    const type = stringValue(recordItem.type)
    const pageIndex = numberValue(recordItem.page_idx)
    if (type === undefined || pageIndex === undefined) continue
    const imagePath = imagePathFrom(recordItem)
    const details = contentDetailsLegacy(recordItem, type, imagePath)
    const textLevel = numberValue(recordItem.text_level)
    blocks.push({
      type, elementType: normalizeElementType(type), text: details.text, ...(details.caption === undefined ? {} : { caption: details.caption }), contentFormat: details.contentFormat, page: pageIndex + 1, readingOrder: readingOrder += 1,
      ...(textLevel === undefined || textLevel <= 0 ? {} : { headingLevel: textLevel }),
      ...(imagePath === undefined ? {} : { imagePath }),
    })
  }
  return blocks
}

function contentDetailsV2(value: unknown, type: string, imagePath: string | undefined): { readonly text: string; readonly caption?: string; readonly contentFormat: PaperElementContentFormat } {
  const content = record(value)
  const normalizedType = type.toLocaleLowerCase()
  const figure = normalizedType === 'image' || normalizedType === 'chart' || normalizedType.includes('figure')
  const table = normalizedType === 'table' || normalizedType.includes('table')
  const equation = normalizedType === 'equation' || normalizedType === 'formula' || normalizedType === 'math' || normalizedType.includes('equation') || normalizedType.includes('formula') || normalizedType.includes('math')
  const caption = contentText(figure ? content.image_caption ?? content.chart_caption : table ? content.table_caption : undefined)
  const fields = figure
    ? [content.image_caption, content.image_footnote, content.chart_caption, content.chart_footnote]
    : table
      ? [content.table_caption, content.table_body, content.table_footnote]
      : equation
        ? [content.math_content, content.formula, content.equation_content]
        : [content.title_content, content.paragraph_content, content.code_content, content.code_caption, content.code_footnote, content.algorithm_content, content.algorithm_caption, content.algorithm_footnote, content.list_items, content.index_items]
  const text = fields.map(contentText).filter(Boolean).join('\n').trim() || contentText(value)
  return { text: text || (imagePath === undefined ? '' : imagePath), ...(caption === '' ? {} : { caption }), contentFormat: figure ? 'image' : table ? 'markdown' : equation ? 'latex' : 'text' }
}

function contentDetailsLegacy(item: Record<string, unknown>, type: string, imagePath: string | undefined): { readonly text: string; readonly caption?: string; readonly contentFormat: PaperElementContentFormat } {
  const normalizedType = type.toLocaleLowerCase()
  const figure = normalizedType === 'image' || normalizedType === 'chart' || normalizedType.includes('figure')
  const table = normalizedType === 'table' || normalizedType.includes('table')
  const equation = normalizedType === 'equation' || normalizedType === 'formula' || normalizedType === 'math' || normalizedType.includes('equation') || normalizedType.includes('formula') || normalizedType.includes('math')
  const caption = contentText(figure ? item.image_caption ?? item.chart_caption : table ? item.table_caption : undefined)
  const fields = figure ? [item.image_caption, item.image_footnote, item.chart_caption, item.chart_footnote] : table ? [item.table_caption, item.table_body, item.table_footnote] : equation ? [item.math_content, item.formula, item.equation_content] : [item.text, item.code_caption, item.code_body, item.code_footnote]
  const text = fields.map(contentText).filter(Boolean).join('\n').trim() || (imagePath ?? '')
  return { text, ...(caption === '' ? {} : { caption }), contentFormat: figure ? 'image' : table ? 'markdown' : equation ? 'latex' : 'text' }
}

function normalizeElementType(type: string): PaperElementType | 'text' {
  const value = type.toLocaleLowerCase()
  if (value === 'image' || value === 'chart' || value.includes('figure')) return 'figure'
  if (value === 'table' || value.includes('table')) return 'table'
  if (value === 'equation' || value === 'formula' || value === 'math' || value.includes('equation') || value.includes('formula') || value.includes('math')) return 'equation'
  if (value === 'code' || value.includes('algorithm')) return 'code'
  if (value === 'list' || value.includes('list')) return 'list'
  return 'text'
}

function imagePathFrom(item: Record<string, unknown>): string | undefined {
  const content = record(item.content)
  const candidate = stringValue(item.image_path) ?? stringValue(item.img_path) ?? stringValue(content.image_path) ?? stringValue(content.img_path) ?? stringValue(content.path) ?? stringValue(content.image)
  if (candidate === undefined) return undefined
  const normalized = candidate.replaceAll('\\', '/').replace(/^\/+/, '')
  if (normalized === '' || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
  return normalized
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join(' ').trim()
  if (typeof value !== 'object' || value === null) return ''
  const item = record(value)
  const text = stringValue(item.content) ?? stringValue(item.text) ?? stringValue(item.title_content) ?? stringValue(item.paragraph_content)
  if (text !== undefined) return text
  return Object.values(item).map(contentText).filter(Boolean).join(' ').trim()
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
