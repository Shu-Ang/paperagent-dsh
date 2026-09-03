/** 面向本地 PaperAgent 论文库、以证据为依据的运行时研究指引。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { loadRuntimeSkillMarkdown } from '../runtime-skill-markdown.ts'

const paperResearchMarkdown = loadRuntimeSkillMarkdown(import.meta.url, 'research')
export const PAPER_RESEARCH_SKILL = paperResearchMarkdown.content

/** 注册统一研究工作流；导入安全规则仍由 paper-import 负责。 */
export function registerPaperResearchSkill(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'paper-research',
    description: '按照正确的导入、正文/元素检索、证据验证和可点击引用流程研究本地 PaperAgent 论文。',
    whenToUse: '当需要询问本地论文、图、表、公式、论文比较、基于证据回答，或导入论文后继续研究时使用。',
    source: 'runtime',
    provider: 'paperagent',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: paperResearchMarkdown.directory },
    content: PAPER_RESEARCH_SKILL,
  })
}
