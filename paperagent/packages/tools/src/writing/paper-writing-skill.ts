/** 面向现有 LaTeX 工作区、以证据为依据的运行时写作指引。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { loadRuntimeSkillMarkdown } from '../runtime-skill-markdown.ts'

const paperWritingMarkdown = loadRuntimeSkillMarkdown(import.meta.url, 'writing')
export const PAPER_WRITING_SKILL = paperWritingMarkdown.content

/** 为用户和 agent 注册工作区安全的 LaTeX 写作工作流。 */
export function registerPaperWritingSkill(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'paper-writing',
    description: '使用经过验证的本地 PaperAgent 证据和 BibTeX，起草、润色、添加引用并最小化修复现有 LaTeX 手稿。',
    whenToUse: '当需要起草或润色 LaTeX 手稿、添加本地论文引用、同步已验证 BibTeX，或安全诊断 LaTeX 引用与编译问题时使用。',
    source: 'runtime',
    provider: 'paperagent',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: paperWritingMarkdown.directory },
    content: PAPER_WRITING_SKILL,
  })
}
