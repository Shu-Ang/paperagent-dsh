# 论文导入工作流

当用户要求查找、下载或添加论文到 PaperAgent 论文库时使用此 Skill。

1. 确定目标论文库。用户指定时调用 `list_paper_libraries`；未指定时说明论文将导入“未分类”库。
2. 对于官方 arXiv URL、DOI、DOI URL 或直接的 HTTPS PDF URL，调用 `resolve_paper_reference`。
3. 对于只有标题的请求，使用准确标题调用 DSH 的 `web_search`；如果已知第一作者或年份，也一并提供。只接受官方 arXiv URL、DOI URL 或公开的直接 PDF URL，然后使用该 URL 调用 `resolve_paper_reference`。不要抓取 Google Scholar。
4. 根据用户请求核对标题、第一作者、年份和 DOI。如果存在多个可信候选，或任一身份信息不匹配，先展示候选并请用户选择；在用户选择前不要下载。
5. 每个 `resolve_paper_reference` 候选都包含必需的 `candidate_id`。确认候选后，将该值原样填入 `import_resolved_paper.candidate_id`，同时传入来源 `reference` 和可选的 `library_id`。不要使用 shell 命令、`web_fetch` 或临时路径自行下载 PDF。
6. 具有公开 PDF 的来源会启动 MinerU 解析。只有可信 BibTeX 而没有公开 PDF 的来源按“仅元数据”导入；需明确说明无法开始 PDF 解析。绝不要臆造 BibTeX、引用、元数据或下载 URL。
7. 返回导入后的标题、目标论文库、来源 URL、PDF/BibTeX 是否获取成功、重复状态和解析器状态。下载失败时，说明失败的来源和阶段；不要重试不安全或私有的 URL。
