import { join, relative, resolve } from 'node:path'
import type { PaperRecord } from './models.ts'
import { requireNonBlank } from './validation.ts'

export function paperArtifactPaths(paper: PaperRecord, revision?: string | null): { readonly directory: string; readonly pdf: string; readonly markdown: string; readonly sourceMap: string; readonly images: string } {
  const paperDirectory = workspaceDataPath(paper.workspacePath, paper.relativeDir)
  // `undefined` means use the paper's active revision. Passing `null` is only
  // used for the paper root itself, which owns original.pdf but never parsed
  // artifacts in the immutable-revision layout.
  const activeRevision = revision === undefined ? paper.parseRevision : revision
  const directory = activeRevision === null
    ? paperDirectory
    : join(paperDirectory, 'revisions', safeRevision(activeRevision))
  return {
    directory,
    pdf: join(paperDirectory, 'original.pdf'),
    markdown: join(directory, 'paper.md'),
    sourceMap: join(directory, 'source-map.json'),
    images: join(directory, 'images'),
  }
}

/** Parse revisions are directory names, not arbitrary relative paths. */
function safeRevision(value: string): string {
  const normalized = requireNonBlank(value, 'parse revision')
  if (!/^[a-zA-Z0-9-]+$/u.test(normalized)) throw new Error('parse revision contains unsupported characters')
  return normalized
}

/** Returns a normalized workspace path suitable for durable comparison. */
export function canonicalWorkspace(path: string): string {
  const resolved = resolve(requireNonBlank(path, 'workspace path'))
  const normalized = resolved.replaceAll('\\', '/')
  // Windows workspace paths are case-insensitive. Without this normalization
  // the same DSH session can create two SQLite/vector namespaces when one
  // request contains `D:\\Work` and another contains `d:\\work`.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Resolves one managed PaperAgent path and rejects every directory escape. */
export function workspaceDataPath(workspacePath: string, relativePath = ''): string {
  const root = resolve(workspacePath, '.paperagent')
  const target = resolve(root, relativePath)
  const escaped = relative(root, target).startsWith('..')
  if (escaped || relative(root, target) === '..') throw new Error('managed path escapes the PaperAgent data directory')
  return target
}
