/** 为 DSH agent 提供确定性论文获取流程的运行时指引。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { loadRuntimeSkillMarkdown } from '../runtime-skill-markdown.ts'

const paperImportMarkdown = loadRuntimeSkillMarkdown(import.meta.url, 'import')
export const PAPER_IMPORT_SKILL = paperImportMarkdown.content

/** 注册内置 Skill；不需要项目根目录或用户 home 路径。 */
export function registerPaperImportSkill(ctx: Context): () => void {
  return ctx.skills.register({
    name: 'paper-import',
    description: '查找经过验证的公开论文来源，将 PDF 和 BibTeX 导入 PaperAgent，并在不使用不安全临时下载的情况下开始解析。',
    whenToUse: '当需要通过标题、DOI、arXiv URL、论文页面 URL 或公开直接 PDF URL 导入论文时使用。',
    source: 'runtime',
    provider: 'paperagent',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: paperImportMarkdown.directory },
    content: PAPER_IMPORT_SKILL,
  })
}
