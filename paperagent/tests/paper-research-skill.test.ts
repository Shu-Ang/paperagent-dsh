import assert from 'node:assert/strict'
import test from 'node:test'
import { PAPER_RESEARCH_SKILL, registerPaperResearchSkill } from '../packages/tools/src/research/paper-research-skill.ts'

test('paper-research skill registers as a user and model invocable PaperAgent runtime skill', () => {
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

  const dispose = registerPaperResearchSkill(context)
  const skill = registration as {
    name: string; source: string; provider: string; description: string; whenToUse: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }; content: string
  }
  assert.equal(skill.name, 'paper-research')
  assert.equal(skill.source, 'runtime')
  assert.equal(skill.provider, 'paperagent')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, true)
  assert.match(skill.description, /证据/)
  assert.match(skill.whenToUse, /图、表、公式/)
  dispose()
  assert.equal(disposed, true)
})

test('paper-research skill keeps import, text retrieval, element retrieval, verification, and citation rules together', () => {
  for (const expected of [
    'paper-import', 'list_papers', 'list_paper_libraries', 'search_paper_library', 'search_paper_elements',
    'read_paper_section', 'read_paper_element', 'find_in_paper_markdown', 'list_paper_references', 'read_paper_reference', 'paperagent-cite:E<n>',
  ]) assert.ok(PAPER_RESEARCH_SKILL.includes(expected), `missing ${expected}`)
  assert.match(PAPER_RESEARCH_SKILL, /将检索结果视为候选证据/)
  assert.match(PAPER_RESEARCH_SKILL, /不要搜索任意文件或调用 `grep`/)
  assert.match(PAPER_RESEARCH_SKILL, /不要手写标题、章节、PDF 页码/)
})
