import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { PAPER_IMPORT_SKILL } from '../packages/tools/src/import/paper-import-skill.ts'
import { PAPER_RESEARCH_SKILL } from '../packages/tools/src/research/paper-research-skill.ts'
import { loadRuntimeSkillMarkdown } from '../packages/tools/src/runtime-skill-markdown.ts'
import { PAPER_WRITING_SKILL } from '../packages/tools/src/writing/paper-writing-skill.ts'

test('every PaperAgent runtime skill loads its co-located SKILL.md body', () => {
  for (const [directory, content, heading] of [
    ['import', PAPER_IMPORT_SKILL, '# 论文导入工作流'],
    ['research', PAPER_RESEARCH_SKILL, '# 论文研究工作流'],
    ['writing', PAPER_WRITING_SKILL, '# 论文写作工作流'],
  ] as const) {
    const source = resolve(import.meta.dirname, '../packages/tools/src', directory, 'SKILL.md')
    assert.equal(content, readFileSync(source, 'utf8').trim())
    assert.ok(content.includes(heading))
  }
})

test('tools build copies every PaperAgent SKILL.md beside its generated entry', () => {
  for (const directory of ['import', 'research', 'writing']) {
    assert.equal(existsSync(resolve(import.meta.dirname, '../packages/tools/lib', directory, 'SKILL.md')), true, `missing built ${directory}/SKILL.md`)
  }
})

test('the built tools entry resolves co-located Skill resources after bundling', () => {
  const builtEntryUrl = pathToFileURL(resolve(import.meta.dirname, '../packages/tools/lib/index.mjs')).href
  const builtWriting = loadRuntimeSkillMarkdown(builtEntryUrl, 'writing')
  assert.equal(builtWriting.content, PAPER_WRITING_SKILL)
  assert.match(builtWriting.directory.replaceAll('\\', '/'), /\/packages\/tools\/lib\/writing$/)
})
