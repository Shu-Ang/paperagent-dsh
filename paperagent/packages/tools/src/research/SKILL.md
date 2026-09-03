# 论文研究工作流

当用户询问 PaperAgent 中已经保存的论文、要求比较论文结论、询问图/表/公式，或希望导入论文后继续研究时使用此 Skill。

## 范围与事实来源

- 只使用当前 DSH 工作区及其本地 PaperAgent 论文库。绝不要根据论文标题、网页摘要或模型记忆推断论文内容。
- 当目标论文库或论文不明确时，使用 `list_paper_libraries` 或 `list_papers`。处于排队、解析中、失败状态，或没有本地解析内容的论文，暂时不能作为论文内容结论的依据。
- 查找并导入新论文时，使用专用的 `paper-import` 工作流。该工作流负责验证来源、下载公开 PDF/BibTeX、导入以及 MinerU 解析；不要使用 shell 命令、`web_fetch`、临时路径或任意二进制下载。

## 检索流程

1. 对正文、方法描述、实验结果或结论的普通问题，调用 `search_paper_library` 并传入用户问题。用户指定目标时，用 `library_id`、`paper_ids` 或 `section` 缩小范围。
2. 对图、图表、表格、公式、代码或列表的问题，先调用 `search_paper_elements`。已知元素类型时设置 `types`，例如 `figure`、`table` 或 `equation`。
3. 将检索结果视为候选证据，而不是精确事实结论的充分依据。使用 `read_paper_section` 获取上下文正文，或使用 `read_paper_element` 读取准确的表格、公式、图注及其他结构化内容。
4. 如果元素需要叙述性上下文，将返回的 `paperId`、`section` 和 Markdown 行范围传给 `read_paper_section`。数据库已经把元素关联到来源 chunk；不要搜索任意文件或调用 `grep`。
5. 只有在需要精确引文、限定范围的正则检查，或在一篇已知论文中继续查找时，才使用 `find_in_paper_markdown`。它不是检索功能的通用替代品。
6. 如果需要从一篇论文的参考文献继续扩展研究，先调用 `list_paper_references` 获取该论文的引用清单；需要核实某一条时，再调用 `read_paper_reference` 并传入论文 ID 和引用序号。参考文献条目只能作为候选线索，不能替代被引用论文自身的正文证据。
7. 对清单中的相关论文进行深入分析前，先确认它们是否已经存在于本地论文库；已存在时使用 `list_papers`、`search_paper_library` 和 `read_paper_section`，不存在时遵循 `paper-import` 工作流导入后再分析。

## 证据与回答规则

- 每个来源于论文的事实性结论，只能使用本轮 PaperAgent 工具返回的 `evidenceId` 引用：在支持该结论后立即写入裸 token `paperagent-cite:E<n>`。
- 不要用反引号包裹 token。不要手写标题、章节、PDF 页码、PDF URL、`[1]` 或其他方括号引用。Host 会校验证据并渲染可点击引用。
- 如果没有匹配的本地证据、解析尚未完成，或请求的来源不存在，要明确说明。必要时提供导入或重新解析建议；不要伪造引用。
- 必须明确标注 DeepSeek 视觉模型生成的内容是“视觉描述”，而不是论文正文声称的事实。

## 简明决策指南

| 用户意图 | 首个动作 |
| --- | --- |
| 查找/下载/添加论文 | 遵循 `paper-import` |
| 查找论文或论文库 | `list_papers` / `list_paper_libraries` |
| 询问普通论文正文 | `search_paper_library` |
| 询问图/表/公式 | `search_paper_elements` |
| 核实上下文或精确结论 | `read_paper_section` / `read_paper_element` |
| 引用原文 | `find_in_paper_markdown` |
| 查看论文引用清单 | `list_paper_references` |
| 查看指定引用条目 | `read_paper_reference` |
