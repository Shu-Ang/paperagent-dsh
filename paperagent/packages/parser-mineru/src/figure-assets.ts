import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { CreatePaperFigureInput, PaperRecord } from '@paperagent/domain'
import type { ContentBlock } from './content-list.ts'

export interface FigureAssetReplacement {
  readonly figures: readonly CreatePaperFigureInput[]
  /** Removes parser-private staging backups after the revision is durable. */
  readonly finalize: () => Promise<void>
}

export async function replaceFigureAssets(
  destination: string,
  paper: PaperRecord,
  markdown: string,
  blocks: readonly ContentBlock[],
  files: ReadonlyMap<string, Uint8Array>,
): Promise<FigureAssetReplacement> {
  const candidates = figureCandidates(blocks, markdown)
  const staged = `${destination}.${randomUUID()}.tmp`
  const backup = `${destination}.${randomUUID()}.backup`
  await rm(staged, { recursive: true, force: true })
  await mkdir(staged, { recursive: true })
  const figures: CreatePaperFigureInput[] = []
  let section = 'Document'
  let movedPrevious = false
  let installed = false
  try {
    for (const candidate of candidates) {
      section = candidate.section
      const source = archiveImage(files, candidate.path)
      if (source === undefined) continue
      const mimeType = imageMimeType(source.path)
      if (mimeType === undefined) continue
      const localName = uniqueFigureFileName(figures.length + 1, source.path)
      await writeFile(join(staged, localName), source.data, { flag: 'wx' })
      const rawCaption = candidate.block?.text.trim() || candidate.caption
      const figureLabel = figureLabelFrom(rawCaption)
      figures.push({
        paperId: paper.id, workspacePath: paper.workspacePath, elementId: candidate.block?.elementId ?? null, ...(figureLabel === undefined ? {} : { figureLabel }), pageNumber: candidate.block?.page ?? 1, sectionTitle: section,
        relativePath: `images/${localName}`, mimeType,
        sha256: createHash('sha256').update(source.data).digest('hex'), rawCaption,
        nearbyText: candidate.block === undefined ? candidate.caption : nearbyFigureText(blocks, candidate.block),
      })
    }
    try {
      await rename(destination, backup)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (figures.length > 0) {
      await rename(staged, destination)
      installed = true
    } else {
      await rm(staged, { recursive: true, force: true })
    }
    return {
      figures,
      // Deleting a stale backup is recoverable housekeeping; never make a
      // durable parse fail after its SQLite state has become ready.
      finalize: async () => { await rm(backup, { recursive: true, force: true }).catch(() => undefined) },
    }
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    if (installed) await rm(destination, { recursive: true, force: true }).catch(() => undefined)
    if (movedPrevious) await rename(backup, destination).catch(() => undefined)
    throw error
  }
}

interface FigureCandidate {
  readonly path: string
  readonly caption: string
  readonly section: string
  readonly block?: ContentBlock
}

/** Prefer ordered Markdown image references, then content-list-only image paths. */
function figureCandidates(blocks: readonly ContentBlock[], markdown: string): readonly FigureCandidate[] {
  let section = 'Document'
  const figureBlocks: Array<{ readonly block: ContentBlock; readonly section: string }> = []
  for (const block of blocks) {
    if (block.headingLevel !== undefined && block.headingLevel > 0) {
      section = block.text.trim() || section
      continue
    }
    if (block.type === 'image' || block.type === 'chart') figureBlocks.push({ block, section })
  }
  const references = markdownImageReferences(markdown)
  const usedBlocks = new Set<ContentBlock>()
  const usedPaths = new Set<string>()
  const candidates: FigureCandidate[] = []
  for (const reference of references) {
    const matching = figureBlocks.find(item => !usedBlocks.has(item.block) && item.block.imagePath === reference.path)
      ?? figureBlocks.find(item => !usedBlocks.has(item.block))
    if (matching !== undefined) usedBlocks.add(matching.block)
    candidates.push({ path: reference.path, caption: reference.caption, section: matching?.section ?? 'Document', ...(matching === undefined ? {} : { block: matching.block }) })
    usedPaths.add(reference.path)
  }
  for (const item of figureBlocks) {
    const path = item.block.imagePath
    if (path === undefined || usedPaths.has(path)) continue
    candidates.push({ path, caption: item.block.text.trim(), section: item.section, block: item.block })
  }
  return candidates
}

function markdownImageReferences(markdown: string): readonly { readonly path: string; readonly caption: string }[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  const results: Array<{ path: string; caption: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /!\[[^\]]*\]\(([^)]+)\)/.exec(line)
    if (match === null) continue
    const path = normalizeArchiveImagePath(match[1] ?? '')
    if (path === undefined) continue
    let caption = ''
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      const candidate = (lines[next] ?? '').trim()
      if (candidate === '') continue
      if (candidate.startsWith('![') || candidate.startsWith('#')) break
      caption = candidate
      break
    }
    results.push({ path, caption })
  }
  return results
}

function normalizeArchiveImagePath(value: string): string | undefined {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (normalized === '' || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
  return normalized
}

function figureLabelFrom(caption: string): string | undefined {
  const match = /\b(?:figure|fig\.?|图)\s*\d+(?:\s*[a-z])?(?:\s*[-.:])?/i.exec(caption)
  return match?.[0]?.trim().replace(/[.:\-\s]+$/, '')
}

function archiveImage(files: ReadonlyMap<string, Uint8Array>, expected: string): { readonly path: string; readonly data: Uint8Array } | undefined {
  const direct = files.get(expected)
  if (direct !== undefined) return { path: expected, data: direct }
  const hit = [...files.entries()].find(([path]) => path.endsWith(`/${expected}`) || basename(path) === basename(expected))
  return hit === undefined ? undefined : { path: hit[0], data: hit[1] }
}

function imageMimeType(path: string): CreatePaperFigureInput['mimeType'] | undefined {
  switch (extname(path).toLocaleLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}

function uniqueFigureFileName(index: number, sourcePath: string): string {
  const extension = extname(sourcePath).toLocaleLowerCase() || '.png'
  return `figure-${String(index).padStart(3, '0')}${extension}`
}

function nearbyFigureText(blocks: readonly ContentBlock[], target: ContentBlock): string {
  const index = blocks.indexOf(target)
  return blocks.slice(Math.max(0, index - 2), index + 3).filter(block => block !== target).map(block => block.text.trim()).filter(Boolean).join('\n').slice(0, 3_000)
}
