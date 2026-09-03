/** Loads a co-located Skill body in source tests and in the built tools package. */

import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RuntimeSkillMarkdown {
  readonly content: string
  readonly directory: string
}

/**
 * tsdown emits one tools entry module, while source tests import each skill
 * registrar directly. Try the source-adjacent file first, then the resource
 * directory copied next to the built entry module.
 */
export function loadRuntimeSkillMarkdown(moduleUrl: string, builtDirectoryName: string): RuntimeSkillMarkdown {
  const candidates = [
    fileURLToPath(new URL('./SKILL.md', moduleUrl)),
    fileURLToPath(new URL(`./${builtDirectoryName}/SKILL.md`, moduleUrl)),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8').trim()
    if (content === '') throw new Error(`PaperAgent Skill body is empty: ${path}`)
    return { content, directory: dirname(path) }
  }
  throw new Error(`PaperAgent Skill body is missing for ${builtDirectoryName}; checked ${candidates.join(', ')}`)
}
