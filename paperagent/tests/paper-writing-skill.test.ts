import assert from 'node:assert/strict'
import test from 'node:test'
import { PAPER_WRITING_SKILL, registerPaperWritingSkill } from '../packages/tools/src/writing/paper-writing-skill.ts'

test('paper-writing skill registers as a user and model invocable PaperAgent runtime skill', () => {
  let registration: unknown
  let disposed = false
  const context = {
    skills: {
      register(value: unknown) {
        registration = value
        return () => { disposed = true }
      },
    },
  } as never

  const dispose = registerPaperWritingSkill(context)
  const skill = registration as {
    name: string; source: string; provider: string; description: string; whenToUse: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }; content: string
  }
  assert.equal(skill.name, 'paper-writing')
  assert.equal(skill.source, 'runtime')
  assert.equal(skill.provider, 'paperagent')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, true)
  assert.match(skill.description, /LaTeX/)
  assert.match(skill.whenToUse, /BibTeX/)
  dispose()
  assert.equal(disposed, true)
})

test('paper-writing skill binds evidence, bibliography synchronization, and LaTeX safety together', () => {
  for (const expected of [
    'draft', 'polish', 'cite', 'latex-fix', 'paper-research', 'search_paper_library',
    'search_paper_elements', 'read_paper_section', 'read_paper_element', 'read_paper_bibliography',
    '\\cite{citationKey}', 'paperagent-cite:E<n>', '-shell-escape', 'Author checks',
  ]) assert.ok(PAPER_WRITING_SKILL.includes(expected), `missing ${expected}`)
  assert.match(PAPER_WRITING_SKILL, /相同引用 key 已存在但元数据不同，应停止/)
  assert.match(PAPER_WRITING_SKILL, /只有 `\.bib` 更新成功后/)
  assert.match(PAPER_WRITING_SKILL, /不要创建新的参考文献文件/)
})
