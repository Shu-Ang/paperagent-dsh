# PaperAgent DSH：当前主路线实现计划

> 实施状态（2026-09-02）：结构化元素索引、MinerU 精准解析、论文库与页级可点击引用已完成首个可运行版本。DashScope `qwen3-vl-embedding`、Elasticsearch 本地索引、异步索引 worker、设置开关、索引状态与手动重建已落地；SQLite 仍是事实来源，ES 中已可见派生向量索引。P2-4 已完成：`search_paper_library`、`search_paper_elements` 与 `search_paper_figures` 会并行执行 SQLite FTS 与 ES kNN、用 SQLite 回填事实字段并 RRF 融合。可选 DashScope `qwen3-rerank`/`qwen3-vl-rerank` 精排已接入 SQLite/Hybrid 检索，并在失败时自动回退。每次调用已把查询、各阶段候选、降级原因和最终排序以受限事件写入 DSH Session。P2-6 的插件侧实现已完成：PaperAgent 通过 `conversation.view` 注册“检索”主标签，展示 Session 内检索列表、阶段详情与 PDF 跳转；此前 DSH `tool-detail` 试验代码已删除，待浏览器验收。P2-8 的源码实现已完成首版：新增 `paper_sections` 章节树、父子关系字段、短段落合并栈、长段落句子边界拆分、结构化元素邻近 chunk 关联、source-map v5，以及章节 descendants 读取/检索；已有论文需要重新解析并重建索引。

本文档只描述当前采用的架构、已实现基线和后续主路线。历史迁移方案、已废弃的本地 PDF 解析器、PostgreSQL/pgvector 方案和已经完成的对齐审计均不再保留。Elasticsearch 与 DashScope 多模态向量检索属于可选扩展：不改变 SQLite 事实来源、默认关闭，也不改变既有工具和引用协议。RAG 诊断复用 DSH Session 日志，但由 PaperAgent 在会话级“检索”视图中展示；它不是额外数据库，也不再耦合 DSH 轨迹工具详情。

代码清理、超大文件拆分、DSH 宿主补丁收敛和质量门禁见独立文档：[cleanup-refactor-plan.md](./cleanup-refactor-plan.md)。会话级“检索”页复用 DSH 已有的 `conversation.view` 插件槽位，不新增 DSH 宿主补丁；此前试验性的通用轨迹详情扩展应在替换完成后移除。

## 1. 目标与边界

`paperagent-dsh` 是安装到 DeepSeek Harness（DSH）的本地优先插件包。DSH 负责项目（Workspace）、对话（Session）、Agent Loop、记忆、轨迹和通用 Web Shell；PaperAgent 只负责论文、解析、检索与论文引用。

必须满足：

- 所有业务实现使用 TypeScript。
- 论文元数据、论文库和检索 chunk 使用 SQLite。
- 原始 PDF、MinerU 的 Markdown 结果和 source map 存放在当前 Workspace 内。
- PDF 只使用 MinerU 精准解析 API；不保留 PDF.js、Poppler 或其他本地解析 fallback。
- 不迁移旧 PostgreSQL、pgvector、Redis 或 Spring AI 数据与代码。
- 不修改 DSH core；通过 bundle 在 DSH 运行时加载插件。
- 默认不启用外部向量服务。基础检索主路线是 SQLite FTS + 受控精确文本检索；启用可选扩展后，DashScope 多模态 Embedding 与 Elasticsearch 作为异步向量召回和混合检索后端。

## 2. 当前架构

```text
DSH Web / Chat / Agent Loop / Memory / Trajectory
                    │
                    ▼
          @paperagent/dsh-paperagent bundle
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
  packages/ui   packages/tools  packages/domain
  页面与设置     Remote/工具       SQLite/文件边界
                    │
                    ▼
          packages/parser-mineru
     MinerU API → Markdown + source map + chunks + elements
```

包职责：

| 包 | 职责 |
| --- | --- |
| `contracts` | 浏览器和 Host 共用的 Remote 契约 |
| `domain` | SQLite schema、论文库/论文、文件路径安全、chunk/element 持久化、embedding job 与内容 revision |
| `parser-mineru` | MinerU 上传、轮询、ZIP 校验、Markdown、source map 与受管图片资产提取 |
| `vision-deepseek`（新增） | 复用 DSH `DEEPSEEK_API_KEY` 的论文图片异步描述客户端、结构化输出校验与重试边界 |
| `embedding-dashscope`（新增，默认关闭） | DashScope 多模态 Embedding 客户端、文本/图片/融合向量模式、批处理、限流和响应校验 |
| `retriever-elasticsearch`（新增，默认关闭） | Elasticsearch 索引管理、向量写入、kNN/混合召回、重建和 SQLite 降级 |
| `reranker-dashscope`（新增，可选） | DashScope `qwen3-rerank`/`qwen3-vl-rerank` 请求、响应校验、超时和错误边界；不依赖 PaperAgent/DSH |
| `tools` | DSH 工具、系统提示、Host Remote、任务调度和凭据解析 |
| `ui` | 左侧论文库入口、论文管理、MinerU/DeepSeek/DashScope Token 与 Elasticsearch 设置页 |
| `bundle` | 唯一可安装的 DSH bundle，只组合上述包 |

## 3. 本地持久化

以 Workspace 为隔离边界。每个 Workspace 使用自己的 `.paperagent` 目录；PaperAgent 不会跨 Workspace 读取论文。

```text
<workspace>/.paperagent/
  papers/
    <paper-id>/
      original.pdf
      revisions/
        <revision-id>/
          paper.md
          source-map.json
          images/             # MinerU ZIP 安全提取的受管图片资产
```

SQLite 记录论文库、论文元数据、MinerU/视觉/embedding 任务状态、章节树 `paper_sections`、文本 `paper_chunks` 和结构化 `paper_elements`。章节是正文的层级父节点，子 chunk 才是默认的正文检索单位；元素记录用于图、表、公式的精确定位与检索；embedding job 只记录待处理 revision 和状态，不把向量事实写入 SQLite。

`revisions/<revision-id>/paper.md` 是用户阅读的 MinerU Markdown 原文；`source-map.json` v5 记录 `sections`、子 `chunks` 与结构化 `elements` 的章节层级、PDF 页码、Markdown 行号和阅读顺序，不保存 bbox。SQLite 是 Agent 检索与引用的事实来源，不是独立的文件副本来源。

启用向量扩展时，Elasticsearch 只保存可重建的派生检索文档和 `dense_vector`，不保存论文事实的唯一副本。SQLite 仍是元数据、正文、元素、视觉描述和任务状态的事实来源；ES 不存放原始 PDF、完整图片资产或密钥。ES 文档使用 `workspace_key`、`library_id`、`paper_id`、`source_id` 组成稳定标识，并写入 embedding 的 provider、model、dimension 和内容 revision。论文删除、重新解析或切换模型后，先更新 SQLite，再异步删除/重建对应派生文档；索引损坏或 ES 不可用时可从 SQLite 全量重建。

删除论文时，只删除该论文 id 对应的受管目录和 SQLite 记录；删除论文库只解除分类，论文变为“未分类”，不删除论文文件。

## 4. MinerU 精准解析

### 4.1 配置与凭据

插件配置只保存凭据引用，不能保存 Token：

```yaml
mineru:
  apiBaseUrl: 'https://mineru.net'
  apiTokenEnv: 'MINERU_API_TOKEN'
  modelVersion: 'vlm'
  enableOcr: false
  enableFormula: true
  enableTable: true
  pollIntervalMs: 3000
  timeoutMs: 600000
```

`MINERU_API_TOKEN`、`DEEPSEEK_API_KEY` 和可选的 `DASHSCOPE_API_KEY` 均由 DSH credentials 管理，位于同一 `$DSH_HOME/.credentials.yaml`。用户也可在 **设置 → PaperAgent** 中分别保存 MinerU Token、DashScope Token；这些 UI 均为只写表单，只显示状态，绝不回显密钥。

解析前由 Host 通过 `ctx.credentials.resolve()` 获取 Token。Token 不得写入插件配置、Remote 响应、浏览器 bundle、日志、Session event 或本地产物。

### 4.2 解析流程

```text
浏览器选择 PDF
  → Host 原子保存 original.pdf 并计算 SHA-256 去重
  → SQLite: queued
  → POST /api/v4/file-urls/batch
  → PUT PDF 到 MinerU 签名 URL
  → 轮询 /api/v4/extract-results/batch/{batchId}
  → 下载并安全读取结果 ZIP
  → 读取 full.md 与 *_content_list_v2.json / *_content_list.json
  → 写入 paper.md、source-map.json、paper_chunks、paper_elements
  → SQLite: ready 或 failed
```

ZIP 解压只在内存中处理，拒绝路径穿越、未知压缩格式、过大压缩包和异常条目。新的 Markdown、chunks 与 elements 必须先完整生成，再原子替换上一份成功产物；失败不会删除原 PDF 或最近一次成功结果。

解析状态显示在论文表格中每篇论文的“解析状态”列：等待解析、解析中（含页数进度）、完成、失败或已取消。错误信息必须说明阶段（创建任务、上传、轮询、下载结果），但不得输出 Token 或签名 URL。

### 4.3 内容处理边界

| 内容 | 当前处理 |
| --- | --- |
| 正文和标题 | 原样保存于 revision 内的 `paper.md`；标题生成 `paper_sections` 章节树，章节直接正文再按自然段形成子 chunk，不写入 `paper_elements` |
| 公式 | 请求 MinerU 开启公式识别；保留 Markdown/LaTeX 原文，单独写入 `paper_elements(element_type=equation)` |
| 表格 | 保留 MinerU 的 Markdown/HTML 表格、表题和表注，单独写入 `paper_elements(element_type=table)` |
| 图片与图表 | Markdown 原文保留；图片文件写入受管 `images/`，同时写入 `paper_elements(element_type=figure)` 和 `paper_figures` |

元素记录只保存 figure、table、equation、code、list，携带类型、章节、PDF 页码、Markdown 行范围和阅读顺序；正文仅由 `paper_chunks` 检索，二者不重复索引。

### 4.3.1 结构化元素索引

当前解析器会把 MinerU content-list 规范化为文本块和 `figure`、`table`、`equation`、`code`、`list` 等结构化块。文本块只参与 chunk 构造，不写入元素表；表格保留 caption/body/footnote，公式保留完整 `math_content`，图片关联实际资产路径。

新增 `paper_elements` 表：

```text
id, paper_id, workspace_path, element_type
section, pdf_page_start, pdf_page_end
line_start, line_end, reading_order
content, caption, content_format
created_at, updated_at
```

`content_format` 用于区分 `text`、`markdown`、`html`、`latex` 和 `image`。`paper_figures` 保留图片哈希、受管相对路径、视觉描述和视觉任务状态，并通过 `element_id` 关联统一元素记录。`paper_elements_fts` 是派生 FTS5 索引，至少索引元素类型、章节、caption 和 content；图片元素还合并原始图注、附近正文和视觉描述。

正文采用“章节父节点 + 自适应自然段子 chunk”的切分策略。解析器维护由标题层级驱动的 section 栈：`3. Method` 建立一级节点，`3.1 Method 1`、`3.2 Method 2` 建立其子节点；章节标题切换时必须先 flush 当前待合并缓冲区，任何 chunk 都不能跨越章节边界。章节标题前后的直接正文归属于当前栈顶 section，子章节正文归属于对应子 section。

每个 section 内维护一个按阅读顺序追加的待合并 chunk 栈/缓冲区。先按空行识别自然段，再按以下规则自适应合并：短段落（初始阈值建议 200～300 字符）优先与同 section 的相邻短段落合并；当前段落较短且合并后不超过 700～1000 字符时，可以吸收到栈顶普通文本 chunk；中等长度段落通常独立成 chunk；超长段落按中文/英文句末标点拆分；单句仍超长且没有可用空格边界时，才执行字符级硬切。合并只发生在同一 section、普通文本 block 之间，不跨标题、figure/table/equation/code/list 或其他硬边界。

合并后的 chunk 仍保存自然段顺序、段落起止序号、Markdown 行范围、PDF 页码范围和 section id。即使一个短段落最终与邻居合并，也必须能够从 source map 追溯到原始段落；section 结束时未达到最小长度的尾部段落不得跨章节强行合并。论文中具有独立语义的定义、定理、命题、总结段和特殊结构可标记为不可合并。

章节父节点使用新的 `paper_sections` 事实表，不重复保存完整章节全文；章节全文通过 revision Markdown 的行范围按需读取。文本 `paper_chunks` 继续作为常规问答的唯一正文检索表；每条子 chunk 通过 `section_id` 指向直接所属 section，并通过 `paragraph_start/paragraph_end` 或等价字段保留段落范围。`paper_chunk_elements(chunk_id, element_id)` 继续记录文本 chunk 与结构化元素的关系。解析成功时，sections、chunks、elements、关联表和 FTS 索引必须在同一替换事务中更新，失败时全部回滚。

`source-map.json` 当前为 v5 目标格式：顶层增加 `sections` 数组，保留 `chunks` 与仅含结构化内容的 `elements` 数组。section 项包括 `id`、`parentId`、`title`、`sectionPath`、`level`、PDF 页码、Markdown 行范围和 `readingOrder`；chunk 项增加 `sectionId`、`chunkType=child`、段落范围和必要的父 section 信息，并继续通过 `elementIds` 关联结构化元素。新产物不记录 bbox。v5 不是对旧内容做猜测式补齐；已有论文应通过重新解析生成完整章节树和子 chunk。

#### 4.3.2 分层 Section 与自适应子 chunk 实施方案

目标结构：

```text
paper_sections
└── 3. Method
    ├── 直接正文：chunk-3-1、chunk-3-2
    ├── 3.1 Method 1
    │   └── chunk-3-1-1、chunk-3-1-2
    └── 3.2 Method 2
        └── chunk-3-2-1、chunk-3-2-2
```

实施要求：

1. 在 `parser-mineru` 中从 MinerU `headingLevel` 和标题编号构造 section 栈；当前 section 变化时先提交 pending chunk，再创建/切换 section。
2. 新增 `paper_sections` 表，至少包含 `parent_section_id`、`title`、`section_path`、`level`、页码、行号和阅读顺序；根级无标题内容归入 `Document` 节点。
3. 给 `paper_chunks` 增加 `section_id`、段落范围和子序号。父 section 不作为默认全文检索文档，避免父子内容重复命中。
4. 把当前 `splitTextBlock` 改造成自然段解析 + 待合并栈：短段落合并、中等段落独立、长段落句子切分、不可分句最后硬切；合并时保留段落和行号 provenance。
5. `get_paper_outline` 改为读取 `paper_sections`；`read_paper_section` 支持按 section id 读取当前 section 或递归包含 descendants，避免模型猜标题；必要时新增 `read_paper_chunk` 读取单个子 chunk 和相邻上下文。
6. SQLite FTS 和 Elasticsearch 只索引 child chunk；检索结果返回 `sectionId`、`sectionPath`、`paragraphIndex` 和 child 位置。命中后可按需扩展同 section 的前后相邻 chunk，但扩展上下文不自动生成新的引用。
7. RRF、Rerank、citation 仍以子 chunk source identity 和真实 Markdown/PDF 坐标为准；父 section 只提供层级和范围，不复制为第二个 citation。
8. 解析器版本和 source-map 升级后，已有论文统一重新解析；解析完成后再按当前 revision 重建 FTS 与 Elasticsearch embedding，禁止为旧 flat section 猜测 parent id。

验收案例必须覆盖：章节直接正文、二级/三级标题、短段落合并、跨页段落、超长单句、标题之间的硬边界、结构化元素边界、同名章节和父 section 递归读取。

### 4.4 图片视觉能力：DSH 原生对话与论文异步描述双路径

视觉能力只使用 DeepSeek 官方模型 `deepseek-v4-flash-vision-exp`，所有调用复用 DSH credentials 中已有的 `DEEPSEEK_API_KEY`；不改变 DeepSeek 视觉描述路径；向量检索属于第 5.6 节的独立可选扩展，不复用该视觉凭据。两条路径共享凭据与模型，但不共享图片存储边界：

```text
                       DSH credentials: DEEPSEEK_API_KEY
                                      |
             -------------------------+-------------------------
             |                                                   |
DSH 原生图片对话                                      PaperAgent 图片描述任务
llm-pi-ai 的 deepseek Provider                         packages/vision-deepseek
DSH durable attachment                                 <workspace>/.paperagent/papers/<id>/images
             |                                                   |
对话 / Agent Loop / 轨迹                               SQLite paper_figures + FTS 检索
```

#### 4.4.1 DSH 原生多模态对话

不修改 DSH core 的 `llm-deepseek` 直接适配器。使用 DSH 已挂载但默认休眠的 `llm-pi-ai` 适配器，为独立的 `deepseek` Provider 配置视觉模型：

```yaml
llm-pi-ai:
  providers:
    deepseek:
      displayName: DeepSeek Vision
      apiKeyEnv: DEEPSEEK_API_KEY
      models:
        - id: deepseek-v4-flash
        - id: deepseek-v4-pro
        - id: deepseek-v4-flash-vision-exp
          name: DeepSeek-V4-Flash-Vision-Exp
          contextWindow: 1000000
          maxTokens: 384000
          input: [text, image]
          reasoningEfforts:
            off:
            high: high
            max: max
```

`models` 是完整替换列表，故必须同时保留仍需显示的文本模型。该配置写入 `$DSH_HOME/settings.yaml`，由 DSH 热加载。视觉模型被选中时，已有的 DSH 图片附件会被持久化并由 `llm-pi-ai` 转为模型输入；文本模型不得接收图片。第一阶段要求用户显式选择视觉模型，不做静默自动换模型。

#### 4.4.2 论文图片的异步描述任务

论文图片不是会话附件，不能为了复用聊天适配器而再复制到 `$DSH_HOME` 的 attachment 存储。解析成功后由 `PaperVisionJobs` 独立排队，`vision-deepseek` 使用 DeepSeek OpenAI 兼容 Chat Completions 接口，以 Base64 data URL 发送图片、MinerU 原始图注、章节标题和受限长度的附近正文。请求使用 `detail: high`、非流式响应、受 JSON 约束的低温度输出。

模型输出必须通过 schema 校验，至少包括 `figureType`、`summary`、`ocrText`、`axesAndLegend`、`keyFindings` 和 `uncertainties`。`raw_caption` 永远保存 MinerU 原始图注；视觉输出只能写入独立的 `vision_description`，不得改写 `paper.md`、source map 或原始图注。模型描述用于召回和辅助阅读，不得被视为论文原文事实。

PDF 解析与视觉任务状态解耦：

```text
PDF 完成       -> papers.parse_status = ready
图片待处理     -> paper_figures.vision_status = queued
图片处理中     -> paper_figures.vision_status = processing
图片完成       -> paper_figures.vision_status = ready
图片失败/取消  -> paper_figures.vision_status = failed / cancelled（可重试）
视觉未启用      -> paper_figures.vision_status = disabled（保留图片与原始图注）
```

视觉失败不改变论文的 `parse_status`，也不删除已生成的 Markdown 或 chunk。任务必须限制并发、单图尺寸和总重试次数；以图片 SHA-256 去重；记录脱敏错误、模型 ID、提示词版本和更新时间，不记录 API Key、图片 data URL 或完整请求体。

#### 4.4.3 图片资产、检索与引用

`parser-mineru` 在内存中安全读取 MinerU ZIP 后，仅将被 content list 引用的图片写入每篇论文的受管 `images/` 目录，并拒绝路径穿越、未知 MIME、超限条目和不匹配的引用。`domain` 新增 `paper_figures` 事实表：

```text
id, paper_id, figure_label, page_number, section_title
relative_path, mime_type, sha256
raw_caption, nearby_text
vision_description, vision_status, vision_model, vision_prompt_version, vision_error
created_at, updated_at
```

图片检索的 FTS 文本由“图号 + 原始图注 + 视觉描述 + 附近正文 + 章节标题”组成。新增 `search_paper_figures(query)`、`read_paper_figure(figure_id)` 和 `retry_paper_figure_description(figure_id)`；前两者返回论文标题、章节、PDF 页码、图号和可验证的原始图注。回答引用视觉结果时，UI 与 Agent 都应标注“视觉模型描述”。

插件配置只保存策略，不保存密钥：

```yaml
paperAgent:
  vision:
    enabled: true
    model: deepseek-v4-flash-vision-exp
    credentialRef: DEEPSEEK_API_KEY
    concurrency: 2
    timeoutMs: 45000
    maxImageBytes: 10485760
    maxRetries: 1
```

## 5. 检索主路线：SQLite FTS + 精确文本兜底

### 5.1 当前基线

当前 `search_paper_library(query, limit)` 从 SQLite 读取当前 Workspace 中状态为 `ready` 的、直接隶属于当前 revision section 的 `paper_chunks`，通过 FTS5/BM25（无 FTS5 时使用受控 lexical fallback）召回少量带定位信息的 citation。后续分层 chunk 方案中，检索仍只面向自然段子 chunk；section 父节点用于范围过滤、上下文扩展和章节读取，不作为默认重复检索文档。图、表、公式将通过结构化元素检索补充。

它已经具备可靠引用所需的论文名、章节、PDF 页码、Markdown 行号与摘录，但不是 SQLite 全文索引：论文库变大时会线性扫描所有 chunk；中文分词、排序质量和精确查找体验也有限。

### 5.2 目标设计

`paper_sections` 保存章节树，`paper_chunks` 继续作为自然段子 chunk 的文本事实表，`paper_elements` 作为图、表、公式等结构化元素事实表。三者分别由当前 revision 的 Markdown/content-list 生成；FTS5 只索引子 chunk 和结构化元素，不能把完整父章节全文复制成另一份默认检索数据源。

```text
论文解析成功
  → 原子替换 paper_sections / paper_chunks / paper_elements
  → 同一事务同步 chunk-element 关联与 FTS5 索引

Agent 普通问题
  → SQLite FTS5 召回 + BM25 排序
  → 按 Workspace / library / paper / section（可含 descendants）过滤
  → 返回子 chunk 的 PaperCitation（标题、章节路径、页码、行号、摘录）

用户要求精确原文、引号短语或正则
  → 受控 Markdown 文本搜索，只允许受管 paper.md 范围
  → 使用 source-map.json 回填页码、章节和行号
  → 同样返回 PaperCitation，不把任意 shell 输出交给 Agent

用户询问图、表或公式
  → `search_paper_elements(query, types)` 从 `paper_elements_fts` 召回
  → 返回元素类型、标签/标题、章节、PDF 页码、Markdown 行号和内容
  → 点击引用时打开对应 PDF 页；首期只提供页级定位，不做原文坐标高亮
```

取舍：

- FTS5 是 Agent 默认入口，适合自然语言问题、候选排序、元数据过滤与可引用结果。
- 受控 Markdown 文本搜索只作为精确字符串、正则、排查原文的补充，不能替代结构化检索。
- 不让 Agent 执行任意 `grep` 命令；提供受限的领域工具，路径必须在当前 Workspace 的 `.paperagent/papers` 内。
- 向量检索、embedding、rerank 不是默认路径。启用可选扩展时，DashScope 多模态 Embedding 与 Elasticsearch 只能作为 `PaperRetriever` provider 和异步派生索引，不能改变工具、`PaperCitation`/`evidenceId` 和引用协议；SQLite FTS5 始终保留为默认入口与降级路径。

### 5.3 FTS 实施步骤

1. 启动时探测 SQLite 是否支持 FTS5；支持时创建/迁移 `paper_chunks_fts` 和 `paper_elements_fts`，只为 child chunk 与结构化元素建立派生索引，不支持时分别降级到文本/元素词法检索。
2. 在解析替换事务内同步删除并重建对应论文的 sections、chunks、elements、`paper_chunk_elements` 和 FTS 索引。
3. 扩展 `search_paper_library` 参数：`query`、`limit`、可选 `library_id`、`paper_ids`、`section`、章节后代范围；新增 `search_paper_elements(query, types, limit)`，`types` 支持 `figure`、`table`、`equation`。
4. 为中文加入规范化与 CJK n-gram/分词策略；文本、表格、公式和图片图注都必须有回归测试。
5. 新增 `read_paper_element(element_id)`，返回受长度限制的原始内容、类型和定位信息；`find_in_paper_markdown` 继续只负责精确文本/正则搜索。
6. `get_paper_outline` 从 section tree 返回精确标题、层级、父节点和范围；`read_paper_section` 支持当前 section 与 descendants；必要时增加 `read_paper_chunk` 读取单个子 chunk 和相邻上下文。
7. Agent 提示词规定：普通论文问题先调用 `search_paper_library`；涉及图、表、公式时调用 `search_paper_elements`，必要时再读取元素详情；需要整节上下文时先使用 outline，再按 section id 读取；没有工具证据时明确说明没有本地依据。

### 5.4 内置 `paper-research` Skill：统一导入、检索与引用工作流

`paperagent` 应提供面向用户与模型均可调用的运行时 Skill，而不是仅依赖零散的 system prompt 和工具描述。现有 `paper-import` 继续专注“发现可信来源、受控下载、导入 PDF/BibTeX、启动 MinerU 解析”；新增 `paper-research` 作为论文库使用的主入口，覆盖导入后的检索、上下文核对与可信引用。

Skill 不访问本地绝对路径、不保存密钥、不自行下载二进制文件，也不绕过已有 Agent 工具。它只编排已经注册的 PaperAgent 工具与 DSH `web_search`：

```text
用户目标
  ├─ 导入论文 / 按标题或 DOI 寻找论文
  │    → 调用 paper-import 工作流
  │    → resolve_paper_reference → import_resolved_paper → MinerU 解析
  │
  └─ 查询已归档论文
       ├─ 普通正文问题
       │    → search_paper_library
       │    → 必要时 read_paper_section
       │
       ├─ 图、表、公式、代码或列表问题
       │    → search_paper_elements(query, types)
       │    → 必要时 read_paper_element(element_id)
       │    → 可根据返回的 paperId / section / 行号读取关联正文 chunk
       │
       └─ 最终回答
            → 只输出本 turn 工具结果登记的 paperagent-cite:E<n>
            → Host 渲染可点击 [n]，跳转论文 PDF 对应页
```

`paper-research` 必须明确以下决策规则：

1. 先确认当前 Workspace 和目标论文库；未指定论文库时查询全部已归档论文，不能猜测其他 Workspace 的内容。
2. 问题要求具体数值、定义、实验结论或原文引号时，检索结果只作候选；必须用 `read_paper_section` 或 `read_paper_element` 核对后再作答。
3. 询问图、表、公式时优先结构化元素检索；需要解释该元素在论文叙事中的作用时，再按元素返回的 `paperId`、`section`、行号读取正文 chunk。
4. 不存在本地证据、论文尚未解析完成、或 PDF/BibTeX 缺失时，明确说明限制；不得以标题、外部搜索摘要或模型记忆替代本地论文证据。
5. 最终论文事实只能引用当前 turn 工具结果的 evidence id；禁止手写论文名、页码、`[1]` 或 PDF URL 伪造引用。

实施项：

1. 在 `packages/tools/src/research/paper-research-skill.ts` 定义运行时 Skill，并在 `plugin.ts` 中注册；保留 `paper-import` 的独立职责，不重复下载规则。
2. 为 Skill 增加 `whenToUse`、用户可调用说明和中文/英文工作流文本；名称固定为 `paper-research`，provider 为 `paperagent`。
3. 补充工具约束：`search_paper_elements` 后若问题需要正文上下文，使用受控 `read_paper_section`，而不是 shell/grep 或任意文件路径。
4. 增加回归测试，验证 Skill 注册、关键工具链、无证据降级说明，以及元素检索 → 正文核对 → evidence 引用的指令完整性。

### 5.5 内置 `paper-writing` Skill：LaTeX 写作、润色与本地文献同步

`paper-writing` 是 `paper-import`、`paper-research` 之后的第三个运行时 Skill。它不新建独立插件，也不让 PaperAgent 接管用户的 LaTeX 项目：DSH 现有的 Workspace 文件读取、最小编辑、文件写入、终端和权限确认能力继续负责 `.tex` / `.bib` 文件；PaperAgent 只负责提供已归档论文的可核对正文证据、citation key 与 BibTeX。论文库 SQLite 不是 LaTeX 项目的第二份文献库，LaTeX 项目中的 `.bib` 才是稿件引用的最终事实来源。

```text
paper-import      → 发现可信来源、导入 PDF/BibTeX、启动解析
paper-research    → 检索正文/图表公式、核对论断、得到对话 evidence
paper-writing     → 读取 LaTeX 项目、写作/润色、同步 .bib、插入 \cite{}、编译验证
```

Skill 名称固定为 `paper-writing`，provider 为 `paperagent`，同时允许用户和模型调用。适用场景包括：撰写论文某一节、基于本地论文起草 Related Work、润色中英文技术段落、插入可信参考文献、修复 LaTeX/BibTeX 编译或引用问题。首版不增加专用 UI；复用 DSH 对话、文件编辑卡片和权限提示。

#### 5.5.1 模式与输入边界

| 模式 | 目标 | 允许修改 |
| --- | --- | --- |
| `draft` | 按用户指定的 `.tex`、章节、提纲和可核对论文证据起草内容 | 仅指定的 LaTeX 正文区块与明确允许的新文件 |
| `polish` | 润色既有技术文本，可选轻度、标准、结构性深度 | 仅指定区块；默认保留公式、标签、引用和模板结构 |
| `cite` | 将已选择论文写入指定 `.bib` 并在指定正文位置插入引用 | 仅指定 `.bib` 与 `.tex` 位置 |
| `latex-fix` | 修复编译、引用、表格、公式、浮动体等问题 | 仅最小必要的 LaTeX 修改 |

用户必须提供目标 `.tex` 路径或明确目标段落；若需要写入 BibTeX，必须提供 `.bib` 路径，或由 Skill 从当前主文档已有的 `\bibliography{...}` / `\addbibresource{...}` 声明中唯一解析出目标。没有既有 bibliography 声明时，Skill 不得擅自重写模板或创建新的引用 backend，必须要求用户指定目标 `.bib` 和方案。所有路径必须位于当前 DSH Workspace 内。

#### 5.5.2 新增只读 PaperAgent 工具

新增 `read_paper_bibliography(paper_ids)`，最大批量数受限（建议 20）。工具只返回当前 Workspace 中已存在的、可审计的书目信息：

```ts
{
  entries: Array<{
    paperId: string
    title: string
    citationKey: string | null
    bibtex: string | null
    doi: string | null
    sourceAdapter: string | null
    metadataStatus: 'ready' | 'missing-bibtex' | 'invalid-bibtex' | 'missing-citation-key'
  }>
}
```

该工具不生成、不补全、也不猜测 BibTeX/DOI/venue/page 等元数据；没有有效 BibTeX 或 citation key 时返回明确状态。它不写入用户 LaTeX 目录，也不接受任意文件路径。`paper-writing` 用它获得参考条目，再通过 DSH 文件工具完成受权限保护的项目编辑。

#### 5.5.3 论证、检索与写作工作流

```text
用户指定 LaTeX 项目、目标 .tex / .bib 和写作或润色要求
  → DSH read：读取目标源文件、相邻上下文、主文件和已有 bibliography 声明
  → paper-research：检索论文正文或结构化元素
  → read_paper_section / read_paper_element：核对具体论断
  → read_paper_bibliography：取得已选择论文的 BibTeX 与 citation key
  → DSH edit：先最小更新目标 .bib，再更新正文 \cite{key}
  → 使用项目既有编译命令验证；读取 .log 与生成 PDF（如存在）
  → 返回修改文件、插入的 citation key、编译结果和 Author checks
```

写作时先构造“研究对象 → 目标条件/危害 → 既有方法局限 → 方法理由 → 验证证据”的工程论证链。数值结果、数据集、baseline、贡献、公式和文献元数据只能来自用户材料或已读取的本地论文；缺失时列入 `Author checks`，不得以流畅的学术语言掩盖证据缺口。润色需要区分轻度语言修正、标准学术改写和结构性重写；默认保留 `\label`、`\ref`、`\cite`、数学环境、表格/图环境和 IEEEtran/现有模板约束。

对话中的 `paperagent-cite:E<n>` 仅服务于 DSH 聊天回答，绝不能写入 `.tex`。稿件正文只使用项目风格允许的 LaTeX 引用命令，默认 `\cite{citationKey}`；不得因为方便而将项目切换到 `\citep`、`\autocite`、BibLaTeX 或另一种 bibliography backend。

#### 5.5.4 BibTeX 同步与冲突规则

1. 优先使用用户指定的 `.bib`，否则只使用主文件已有声明唯一指向的 `.bib`。
2. 写入前解析目标 `.bib`：先按 citation key 检查，再按 DOI 或规范化标题/作者/年份检查等价条目。
3. 已存在等价条目时不重复追加；同 key 但元数据不同属于冲突，必须展示差异并请求用户确认，不能静默覆盖、删除或自动改名。
4. BibTeX 条目验证通过后才最小追加到 `.bib`；保持原文件编码、行尾和已有条目顺序，不整体重写文献库。
5. `.bib` 更新成功后，才在用户指定的正文位置插入 `\cite{key}`；引用位置不明确时要求用户选择句子或段落，不能猜测论断归属。
6. BibTeX 缺失、citation key 缺失或元数据不可验证时，不插入空引用；可以提示用户补充 BibTeX 或回到 `paper-import` 重新导入。

#### 5.5.5 LaTeX 编译与安全验证

优先读取项目已有的构建说明、`latexmkrc`、CI 配置或用户指定命令；没有明确构建方式时，先说明可用的候选命令而不盲目改动模板。编译仅在当前 Workspace 内执行，禁止 `-shell-escape`，不安装包、不替换文档类、不改变 bibliography backend。成功后检查 `.log` 中的未解析引用、重复 label、编译错误和 overfull/underfull box；若可得到 PDF，还应检查相关页面的基本可读性。修复采用最小变更原则，始终保留作者原有的科学内容。

#### 5.5.6 实施项与验收

1. 在 `packages/tools/src/writing/paper-writing-skill.ts` 定义并注册运行时 Skill；它编排 `paper-research`、新增书目读取工具和 DSH 文件能力，不直接承担下载或任意路径写入。
2. 在 `domain` 增加受 Workspace 约束的书目读取方法，在 `plugin.ts` 注册 `read_paper_bibliography`；返回值必须经过 BibTeX/citation key 可用性校验。
3. 在 Skill 指令中固化 `draft`、`polish`、`cite`、`latex-fix` 的工具顺序、最小修改原则、`Author checks` 输出和 LaTeX/聊天引用边界。
4. 增加 Domain/Tool/Skill 回归测试：Workspace 隔离、批量上限、缺失 BibTeX、citation key 缺失、同 key 冲突、条目去重、元素检索后正文核对、禁止将 `paperagent-cite` 写入 `.tex`。
5. 增加 LaTeX 工作区 E2E fixture：BibTeX 与 BibLaTeX 两类已有项目、`\cite{}` 插入、已有条目幂等、编译成功、未解析引用和冲突的安全失败；不要求首版新建或替换 IEEE 模板。

### 5.6 可选扩展：DashScope 多模态 Embedding + Elasticsearch

#### 5.6.1 设计决策与边界

该能力默认关闭，不改变现有 Agent 工具名称或引用协议。SQLite 仍是唯一事实来源；Elasticsearch 是可删除、可重建的派生索引，SQLite FTS5 是始终可用的降级路径。只有用户在 PaperAgent 设置中明确开启并配置服务时，文本、图注或图片才会离开本机发送到 DashScope；API Key 由 DSH credentials 管理，不能写入 YAML、SQLite、日志或 Session event。设置页已提供 DashScope API Key 与 Elasticsearch API Key 的只写输入，以及各自的启用开关；ES 连接测试由 Host 端执行，浏览器只接收节点/集群/版本信息，永不接收密钥。DashScope 向量写入、Elasticsearch 建索引、索引任务状态和 Agent `PaperRetriever` 的 Hybrid kNN 查询均已完成；后续只补 alias 切换和全量 reconcile。

DashScope 适配器优先使用官方多模态 Embedding 接口（qwen3-vl-embedding 或当前账户可用的等价模型）。第一阶段采用融合向量：文本 chunk 使用正文；figure 使用图注、附近正文和视觉描述，若本地存在图片则同时传图片；table 使用 caption 和规范化表格文本；equation 使用 LaTeX 和章节上下文。这样可以先实现“文本问题召回相关图片/表格”，而不改变现有图片描述链路。第二阶段再增加独立 image 向量，使用户上传图片或视觉查询可反向召回论文图。

官方接口与实现依据：

- DashScope 多模态 Embedding API：https://help.aliyun.com/zh/model-studio/multimodal-embedding-api-reference
- Elasticsearch dense_vector 映射：https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/dense-vector
- Elasticsearch kNN 检索：https://www.elastic.co/docs/solutions/search/vector/knn

#### 5.6.2 数据流与包划分

~~~text
MinerU / DeepSeek Vision
        │
        ├─ SQLite：paper_sections / paper_chunks / paper_elements / paper_figures（事实）
        │
        └─ embedding job（异步、可重试）
              → embedding-dashscope
              → retriever-elasticsearch
              → chunks/elements 派生向量索引

search_paper_library / search_paper_elements
        → PaperRetriever（当前为 SQLite FTS5；后续可替换为 HybridRetriever）
        → 按 workspace/library/paper 过滤并合并
        → SQLite 回填原文和定位
        → 生成现有 PaperCitation / evidenceId
~~~

已落地的稳定检索边界：

~~~text
packages/retrieval/
  src/index.ts               # PaperRetriever 契约、统一输入/结果、SqlitePaperRetriever 默认实现
~~~

Agent 的 `search_paper_library`、`search_paper_elements`、`search_paper_figures` 只依赖 `PaperRetriever`，不再直接调用 SQLite 召回方法。默认实现仍调用既有 FTS/词法索引并返回完全相同的已回填 citation；`read_paper_section`、`read_paper_element` 等受控精确读取继续直接访问 SQLite，不属于可替换的召回层。后续 ES 实现必须先按候选 ID 排序，再从 SQLite 回填 citation，不能将 ES 文档直接暴露给工具或引用链。

后续新增包保持独立、默认不随运行时启用：

~~~text
packages/embedding-dashscope/
  src/client.ts              # HTTPS 请求、超时、限流、响应校验
  src/provider.ts            # MultimodalEmbeddingProvider 实现
  src/models.ts              # 模型、维度和输入模式白名单

packages/retriever-elasticsearch/
  src/client.ts              # 节点连接与健康检查
  src/index-manager.ts       # mapping、alias、版本化索引
  src/vector-retriever.ts   # kNN 查询
  src/hybrid-retriever.ts   # ES + SQLite FTS 合并
  src/reindex-service.ts    # 全量/增量重建
~~~

domain 增加 embedding 任务和 revision 查询，但不依赖 Elasticsearch SDK；tools 负责调度、工具参数和降级；parser-mineru、vision-deepseek 只在解析/视觉任务完成后发出待索引事件；ui 增加开关、连接测试、索引状态和重建操作。

#### 5.6.3 Embedding provider 契约与 DashScope 调用

领域层只依赖抽象契约：

~~~ts
interface MultimodalEmbeddingProvider {
  readonly id: string
  readonly model: string
  readonly dimensions: number
  embed(input: {
    mode: 'text' | 'image' | 'fused'
    text?: string
    imageBytes?: Uint8Array
    mimeType?: string
  }): Promise<readonly number[]>
}
~~~

适配器通过 HTTPS POST /api/v1/services/embeddings/multimodal-embedding/multimodal-embedding 调用 DashScope，典型请求为：

~~~json
{
  "model": "qwen3-vl-embedding",
  "input": {
    "contents": [
      { "text": "图 2 展示跨模态特征映射..." },
      { "image": "data:image/png;base64,..." }
    ]
  },
  "parameters": { "enable_fusion": true, "dimension": 1024 }
}
~~~

实际模型可用维度以 DashScope 返回和账户能力为准；启动时校验 provider/model/dimension，写入 ES 前再次校验向量长度。单图/单文本大小、批大小、并发、QPS、连接和读取超时都必须配置上限；429、5xx 和网络错误按指数退避重试，4xx 参数错误直接失败并保留脱敏原因。图片只在启用 fused 或 image 模式时上传，失败时不得把 Base64 写入日志。

视觉描述完成后必须重新生成对应 figure 的向量（内容 revision 递增）；只修改元数据不应触发全库重建。模型或维度改变时创建新版本索引并后台重建，完成后原子切换 alias，禁止把不同维度向量写入同一索引。

#### 5.6.3.1 图、表与公式的上下文构造（结构优先）

第一阶段统一使用 `qwen3-vl-embedding`，使文本、图片、表格和公式处于同一向量空间；但不同元素必须按各自语义构造输入，禁止把整页 PDF 文本或仅按二维坐标最近的内容直接拼接。正文 chunk 使用正文和章节标题；figure 在本地图片可用时采用 fused 输入（图片 + 结构化文本），table/equation 使用 text 输入。每个元素只写一个融合后的派生向量；独立纯图片向量留待 V5 的“以图搜图”功能。

图、表的结构化文本按以下优先级生成：

1. **Caption（必选）**：`paper_elements.caption` / 原始 caption 是元素自身最强的语义描述，始终保留。
2. **同一叶子 section 的编号引用段（优先）**：在元素直接所属的 `section_id`（例如 `3.1 Method 1`）的正文子 chunk 中识别与元素标签匹配的引用，例如 `Figure 3`、`Fig. 3`、`Table II`、`表 3`。按解析阅读顺序选择首次具有解释性内容的命中段；为保持句子完整，可带该 section 前后各一个子 chunk。重复的结果讨论段只能在没有更早解释段时补充，不能覆盖首次解释段。
3. **同一叶子 section 的解析顺序相邻子 chunk（兜底）**：若没有可靠编号引用，利用 MinerU `content_list` 顺序和 source-map 的稳定 element/child-chunk 顺序，选择元素前后相邻的正文子 chunk。此处的“相邻”是逻辑阅读顺序，不是 PDF x/y 坐标或文件行号；必要时可以向父 section 回溯标题和范围，但不得跨越父 section 的兄弟节点。
4. **页码约束（次级兜底）**：仅在同章节候选无法区分时，优先同页，再优先相邻页。双栏版面、浮动图表、跨页表格不能因为几何位置最近而跨章节绑定正文。
5. **无可靠上下文时降级**：只索引 caption、规范化表格文本或 LaTex/公式文本及章节名；宁可缺少附加正文，也不得绑定另一列、另一图或另一章节的内容。

最终投影必须保留字段边界，便于调试、重建和后续 rerank，而非生成不可解释的自由文本。例如：

~~~text
[Caption]
Figure 3. ...

[Section]
4. Experiments

[In-text explanation]
As shown in Fig. 3, ...

[Local context]
...
~~~

对 table 使用同一流程，并把规范化表格单元格文本置于 `[Table content]` 字段；对 equation，则优先选择同章节内定义变量、解释公式或给出推导的前后段，并将 LaTex 置于 `[Equation]` 字段。所有被选中的 chunk ID、选择原因（`caption`、`in_text_reference`、`logical_neighbor`、`page_fallback`）和 source revision 都要写入 embedding job 的输入快照或可重建投影，避免 PDF 重解析后混入旧上下文。

#### 5.6.4 Elasticsearch 索引与同步

使用两个版本化索引和 alias，避免 child chunks 与元素的字段语义混杂：

- paperagent-chunks-v1：source_id=chunk:{chunkId}，正文、section_id、section_path、parent_section_id、child 序号、页码、embedding；只写入 `chunkType=child` 的子 chunk。
- paperagent-elements-v1：source_id=element:{elementId}，element_type、caption、content、图片相对路径、页码、embedding。

公共字段包括 workspace_key、library_id、paper_id、section、section_id、section_path、parent_section_id、pdf_page_start、pdf_page_end、content_revision、embedding_provider、embedding_model、embedding_dimension、indexed_at。embedding 映射使用 dense_vector，维度固定为当前配置；正文和元素内容仅用于召回后展示，最终摘录必须从 SQLite 回填。父 section 不重复写入默认 chunks 索引；若未来增加章节级向量，应使用独立的 sections 索引和摘要/中心向量。

索引写入采用幂等 bulk upsert，稳定 _id 由 workspace + paper + source + revision 计算。每个查询必须带 workspace_key，并按需要附加 library、paper、element type 和 parse_status=ready 过滤；禁止跨 Workspace 的 kNN。删除论文、替换解析结果、删除论文库时同步发出删除任务，孤儿文档由定期 reconcile 清理。

解析事务提交后才创建 embedding job，不能在 SQLite 事务内调用网络。任务状态写入 paper_embedding_jobs：

~~~text
id, workspace_key, paper_id, content_revision
provider, model, dimension
status, total_items, completed_items
last_error, retry_count, created_at, updated_at
~~~

worker 按论文/元素增量处理，支持 queued、processing、ready、failed、cancelled；进程重启可恢复 processing。队列失败不影响 papers.parse_status=ready，也不阻塞论文详情和 FTS 检索。

#### 5.6.5 混合检索与图片检索

内部实现分为 SqliteRetriever、ElasticsearchRetriever 和 HybridRetriever。默认调用 SqliteRetriever；扩展开启后，HybridRetriever 并行执行 SQLite FTS5/BM25 与 ES kNN，再用 Reciprocal Rank Fusion（RRF）或可配置的加权分数合并，去重后只保留少量候选。候选的正文、caption、章节、页码、elementId 和 excerpt 统一从 SQLite hydrate，随后沿用现有 evidence 注册和 PaperCitation 生成。

第一阶段支持文本问题 → 文本/图/表/公式候选；search_paper_elements 可增加 semantic=true 但保持原有参数兼容。第二阶段支持 image input → image_vector 的反向图检索，查询图片只在用户主动上传且启用视觉检索时发送 DashScope。无向量、向量维度不匹配、ES 超时或服务不可用时，自动回退 SQLite FTS，并在工具结果中返回 retrieval_mode=sqlite，不向用户伪造“已使用向量检索”。

无论召回来源为何，工具返回格式、evidenceId、页码、章节、行号和行内引用渲染完全不变；向量相似度只能排序，不能替代 read_paper_section/read_paper_element 的原文核对。

#### 5.6.5.1 P2-4：Hybrid RAG 检索链路（V1 已实现）

正文、结构化元素与图片检索主链均已改为可选择的 SQLite / Hybrid 实现：`search_paper_library` 查询 chunk 索引；`search_paper_elements` 查询 element 索引且保留论文库、论文、章节、元素类型过滤；`search_paper_figures` 查询 element 中的 figure 向量后按 `elementId` 回填受管 figure。没有关联结构化 element 的图片仍由 SQLite FTS 正常召回，不会因 ES 缺失而不可见。

```text
search_paper_library(query, filter, limit)
  ├─ SQLite FTS5 / 词法召回（始终执行）
  ├─ 条件满足时并行：DashScope query embedding → Elasticsearch kNN
  ├─ 以 source_kind + source_id 去重
  ├─ 按候选 id 从 SQLite hydrate 标题、章节、页码、摘录和事实状态
  ├─ RRF（Reciprocal Rank Fusion）融合排序
  └─ 返回 final top-k → 既有 evidenceId / PaperCitation / 行内引用链
```

**检索边界与接口：**

1. `@paperagent/retriever-elasticsearch` 新增只读 `searchKnn()`：输入 query vector、索引名、`workspace_key`、library/paper/type filter 与候选上限；输出仅含稳定 `sourceKind/sourceId`、`paperId`、rank、score、内容 revision。每个请求必须限定 `workspace_key`，并拒绝模型、维度或 revision 不兼容的文档。
2. `@paperagent/embedding-dashscope` 新增 `embedQuery(text)`，复用写入阶段的模型、维度、超时和脱敏错误策略；查询向量不落 SQLite、ES、session 或日志。
3. `@paperagent/retrieval` 扩展 `PaperRetriever` 输入，允许传入**一次调用独有**的 trace collector；新增 `ElasticsearchPaperRetriever` 与 `HybridPaperRetriever`。禁止把 trace 或候选缓存在全局 Retriever 实例上，以免并行 tool call 串线。
4. SQLite 召回应暴露原始 BM25/词法 score 或至少稳定 rank；ES 暴露 kNN score。融合不得直接比较两种异构 score，首版固定采用 `RRF(k=60)`，并记录 `sqliteRank`、`elasticRank` 与 `fusionScore`。
5. ES 仅作为候选召回器：final hit 必须回到 SQLite 校验 `workspacePath`、论文 `ready` 状态、当前 revision、章节、页码与摘录。删除、重解析或索引滞后造成的孤儿候选直接丢弃。
6. Vector 开关关闭、缺凭据、索引不存在、ES 超时、查询 embedding 失败或 kNN 返回异常时，返回 SQLite 结果而非抛出整次工具错误；同时产生明确的 `skipped`、`fallback` 或 `failed` 阶段原因。用户和模型不得被伪告知“已使用向量检索”。

`PaperRetriever` 的目标形状如下；`trace` 是内部诊断 sink，不进入工具输出 schema，也不进入 LLM 上下文：

~~~ts
interface RetrievalTraceSink {
  stage(input: RetrievalTraceStage): void
}

interface ChunkRetrievalInput {
  workspacePath: string
  query: string
  limit?: number
  filter?: PaperSearchFilter
  trace?: RetrievalTraceSink
}

interface RetrievalResult<Hit> {
  mode: 'sqlite' | 'vector' | 'hybrid'
  hits: readonly Hit[] // 均已由 SQLite hydrate
}
~~~

当前版本将 **RRF 融合排序** 与可选的 **DashScope Rerank 最终精排** 分为两个阶段。RRF 负责候选融合，DashScope Rerank 负责最终精排，二者分数不能直接相加，且必须在轨迹中单列输入范围、耗时和结果。

#### 5.6.5.2 （已废弃）DSH 轨迹工具详情试验

> 以下方案仅记录已验证的 Session trace 事件格式与脱敏边界，不再作为主路线实施。RAG 可观测性将迁移至紧随其后的 PaperAgent 会话级“检索”主标签；完成浏览器验收后，本节涉及的 DSH `tool-detail`、`ui-trajectory` 与 PaperAgent 轨迹投影代码必须删除。

RAG 过程不新增 PaperAgent 页面、不在聊天答案下增加卡片，也不把全部候选塞进模型可读的 tool result。它应显示在 DSH 已有的“轨迹”视图中，并与触发检索的工具调用通过 `callId` 关联：

```text
DSH trajectory
  search_paper_library（已有 tool/call → tool/result 节点）
    └─ RAG 详情页签
       ├─ Query 与 filter
       ├─ SQLite 召回：候选、rank、score、耗时
       ├─ Query embedding：状态与耗时（不显示向量）
       ├─ Elasticsearch kNN：候选、rank、score、耗时
       ├─ RRF 融合：去重来源、fusion score、最终排名
       └─ 返回给 LLM：最终 evidence 对应的 citation；可跳 PDF 目标页
```

轨迹数据写入 DSH session，而不是新增 PaperAgent SQLite 表；它天然与对话 turn/step 绑定、随会话历史回放，也无需处理跨 session 清理。定义版本化事件：

~~~ts
interface PaperRetrievalTraceEventData {
  version: 1
  callId: string
  turn: number
  step: number
  toolName: 'search_paper_library' | 'search_paper_elements' | 'search_paper_figures'
  totalMs: number
  query: { text: string; limit: number; filters: Record<string, unknown> }
  stages: readonly RetrievalTraceStage[]
  warnings: readonly string[]
}

interface RetrievalTraceStage {
  kind: 'sqlite' | 'embedding' | 'elasticsearch' | 'fusion' | 'rerank' | 'final'
  status: 'completed' | 'skipped' | 'fallback' | 'failed'
  durationMs: number
  method?: 'fts' | 'knn' | 'rrf' | 'dashscope-rerank'
  reason?: string
  candidates: readonly RetrievalTraceCandidate[]
}
~~~

候选必须受限和脱敏：每阶段最多保留 20--30 条，每条 excerpt 最多 300 字；禁止记录 query embedding、API Key、Authorization header、Base64 图片、完整 ES request、完整 reranker prompt 或完整论文正文。事件 decoder 必须校验长度、枚举、页码、分数有限性和 `callId`；未知版本会解码为受限的“不支持版本”记录（有 `callId` 时在工具详情提示版本不可用），不能再造成历史 session 无法加载。

**DSH 与插件的职责划分：**

1. PaperAgent Host 在模块加载时调用 `registerKnownSessionEventType('paperagent/retrieval-trace', { decode })`，与既有 `paperagent/citations` 一样保证历史读取早于 Cordis `apply()` 时也可识别；检索完成后通过 `session.append('paperagent/retrieval-trace', data)` 追加事件。
2. PaperAgent Web 客户端通过 `ctx.conversationEvents.register()` 注册 `ConversationNodeDefinition`：`match()` 以 `callId` 建立稳定 identity，`start()/update()` 保存验证后的 trace，且必须同时声明 `target: 'trajectory'` 与 `buildViewNode()`。
3. 本试验未保留 `ui-trajectory` 改动；当前实现不要求 DSH 增加 `tool-detail` 契约。
4. PaperAgent UI 已注册检索视图的事件投影，因此在检索页选中任一检索工具（正文、元素或图片）后即可查看查询、SQLite、embedding、Elasticsearch、RRF、可选 rerank、final 阶段及候选。候选点击复用当前 PDF preview 的 `paperId + pdfPageStart` 跳转；不创建第二套 PDF 路由。
5. 当前主路线使用 PaperAgent 自己的 `conversation.view`“检索”标签，不修改 Agent loop、不伪造 `tool/code-dispatch` 子调用；RAG 阶段仅作为插件事件和检索视图数据。

需要由 DSH 提供的通用客户端契约建议为：

~~~ts
interface TrajectoryToolDetail {
  callId: string
  rendererId: string
  data: unknown
}

// 轨迹快照按 callId 保存详情；工具详情区域提供该 slot。
interface TrajectorySnapshot {
  toolDetails: ReadonlyMap<string, readonly TrajectoryToolDetail[]>
}
// slot: 'trajectory.tool-detail'
// input: { call: ToolCallBlock; result: ToolResultNode; details: readonly TrajectoryToolDetail[] }
~~~

这是一处 DSH 通用可扩展能力：任何插件都可把“某次工具调用的受限诊断详情”挂到轨迹工具节点，不需要再次改 DSH，也不会形成 PaperAgent 对框架的业务耦合。

**说明：**以上 `tool-detail` 方案为已废弃的设计记录，不再执行；当前实现的 Hybrid、trace、元素/图片检索和会话级“检索”视图均已按后续主路线完成。

#### 5.6.5.3 P2-6：会话级“检索”主标签（当前主路线）

RAG 过程不在聊天答案下增加卡片，也不把全部候选塞进模型可读的 tool result。PaperAgent 应复用 DSH 已有的 `conversation.view` 插件槽位，在当前 Session 顶部注册第三个主标签：

```text
对话 | 轨迹 | 检索
```

点击“检索”后，中央内容区由 PaperAgent 的会话级视图接管；左侧会话栏、会话标题、输入栏和 DSH 的会话切换行为保持不变。它展示当前会话内所有产生 RAG trace 的调用，不再与某一个 `search_paper_library` 工具行或轨迹右侧卡片强耦合。

**边界与数据来源：**

1. 不新增 DSH core 或 `ui-trajectory` 代码。`conversation.view`、每 Session 的 `ChatStoreState.view`、顶部标签渲染和 Session 历史回放均为 DSH 已有插件能力。
2. 继续将版本化 `paperagent/retrieval-trace` 写入 DSH Session；V1 不新增 PaperAgent SQLite 表。这样 trace 与 turn/step 同步、历史重放后仍可恢复，且无需跨 Session 清理。
3. PaperAgent Host 保留 `registerKnownSessionEventType('paperagent/retrieval-trace', { decode })`，保证历史文件在插件 `apply()` 前可被安全读取。检索成功、fallback 和失败均追加受限事件。
4. 每阶段只记录 UI 所需的 query、filters、状态、耗时、候选定位、分数、排序与脱敏降级原因；禁止记录 API key、完整 embedding、完整 PDF 正文、原始 HTTP body、签名 URL、Base64 图片或未截断模型输出。

```text
paperagent/retrieval-trace（Session event）
        ↓ PaperAgent 的 ConversationViewDefinition / SnapshotBuilder
paperagent-retrieval snapshot（按 Session、seq、callId 排序）
        ↓ PaperAgent 注册 conversation.view
检索列表 + 单次检索详情
```

`paperagent-retrieval` 是 PaperAgent 自己的 Conversation View target；它只消费本插件事件。它不对 `ui-trajectory` 作值导入、不注册虚假的 DSH tool/subtool 节点，也不暴露给模型作为额外工具调用。

**UI 与交互：**

```text
检索视图
├─ 左侧：当前会话检索列表
│   时间 / Query 摘要 / 工具名 / 状态 / 总耗时 / 最终命中数
└─ 右侧：选中记录的详情
    概览 | SQLite | Embedding | Elasticsearch | Rerank | Final
```

- 列表默认按 Session event `seq` 倒序，支持 query、工具名和失败状态筛选。
- 概览显示 query、filters、关联 turn/step、callId、总耗时和最终返回数量。
- 每个阶段显示状态、耗时、降级原因和候选表；候选表包含论文标题、章节、PDF 页码、摘要片段、该阶段分数、融合后分数和排名。
- `Final` 显示实际返回给 LLM 的 Evidence ID 与候选顺序；候选点击复用现有 `paperId + pdfPageStart` PDF 预览/跳页能力，不新增第二套 PDF 路由。
- 页面使用 DSH 既有 UI primitives 与主题 token；可借鉴轨迹的“列表 + 详情”信息密度，但不复制或依赖轨迹组件实现。

**实施顺序与验收：**

1. 在 `packages/ui` 注册 `conversation.view`，ID 固定为 `paperagent-retrieval`、标签为“检索”，并验证对话/轨迹不受影响。
2. 将 Retrieval trace decoder、客户端事件定义和 snapshot builder 收敛到 PaperAgent UI；按 `callId` 保持一次调用的阶段顺序，按 `seq` 保持跨调用顺序。
3. 实现列表、筛选、详情阶段标签、候选表与 PDF 跳转；空 Session、旧日志无 trace、解析中 trace、ES fallback/failed 都必须有明确空态或状态，不能白屏。
4. 增加 Session replay、同一 turn 多检索不串行、候选截断与敏感字段不落日志、切换会话隔离、PDF 页码跳转的 Node 与浏览器 E2E 测试。
5. 已删除本节 5.6.5.2 所述的 DSH `tool-detail` 服务、轨迹 snapshot/标签渲染改动，以及 PaperAgent 对该服务的事件投影；保留 Session event 与本插件会话级检索视图。浏览器验收只验证本插件视图。

#### 5.6.6 配置、设置 UI 与本地 Docker

插件配置只保存开关和凭据引用：

~~~yaml
paperAgent:
  embedding:
    enabled: false
    provider: dashscope
    model: qwen3-vl-embedding
    dimension: 1024
    mode: fused                 # text | fused | image
    credentialRef: DASHSCOPE_API_KEY
    concurrency: 2
    batchSize: 8
    timeoutMs: 30000
  elasticsearch:
    enabled: false
    node: http://127.0.0.1:9200
    indexPrefix: paperagent
    apiKeyRef: PAPERAGENT_ES_API_KEY
    syncMode: async
~~~

设置页沿用 MinerU/DeepSeek 的 DSH 风格，增加：DashScope Token 只写输入、Embedding 启用开关/模型/维度/模式、ES 地址/API Key 引用、连接测试、当前索引 revision、队列进度和“重建索引”按钮。重建前显示预计条目数和云端发送范围；禁用后停止新任务但保留已有 SQLite 数据。

开发机可用单节点 Docker Compose，数据使用命名 volume，端口只绑定 127.0.0.1，版本固定并预留至少 4GB Docker Desktop 内存：

~~~powershell
cd infra/elasticsearch
docker compose up -d
~~~

Compose 仅用于本地开发/验收；不得把 docker compose down -v 写入脚本或文档的常规停止流程，以免误删索引。生产或共享环境必须使用 TLS、认证、资源上限和独立备份策略。

#### 5.6.7 分阶段实施与验收

| 阶段 | 实施项 | 完成标准 |
| --- | --- | --- |
| V1 | provider 抽象、DSH credentials 引用、SQLite embedding jobs | 默认关闭；任务可恢复、重试、取消，密钥不落盘 |
| V2 | DashScope 文本/融合 embedding | 文本 chunk、figure/table/equation 均可生成向量；严格校验维度、MIME、限流和错误 |
| V3 | ES mapping、alias、增量同步和全量重建 | Docker 单节点可运行；workspace 过滤、幂等 upsert、删除和重建通过测试 |
| V4 | HybridRetriever 接入现有搜索工具 | ES+FTS 合并排序；ES 故障自动回退；引用/evidence 契约和 UI 不变 |
| V5 | 独立 image vector 与评测 | 用户图片可召回论文 figure；对比 FTS、向量和混合 Recall@k；隐私提示完整 |

最低验收集：同一文本问题在 SQLite、ES、混合三种模式下均能回填相同 paperId/elementId/pdfPage；重解析后旧 revision 不会污染结果；ES 停止时普通检索仍可用；模型维度变更能安全重建；图注缺失时视觉描述仍可参与召回；任何回答仍必须经过原文读取和现有行内引用校验。

## 6. Agent 与引用闭环

当前 DSH 已提供会话、记忆、轨迹、工具结果 `presentationMeta` 以及按 key 注册对话节点/工具卡片的扩展点。PaperAgent 已有论文检索工具，但当前回答中的 `[标题，章节，PDF p.N]` 仍是 LLM 按提示词手写，不能作为可信的 UI 引用。

### 6.1 结构化引用协议

#### 6.1.1 问题与原则

`search_paper_library`、`search_paper_elements`、`find_in_paper_markdown` 和 `read_paper_section` 返回统一 `PaperCitation`：包含不可由模型自行伪造的 `citationId`、`paperId`、标题、章节、元素类型、元素标签、物理 PDF 页码、Markdown 行范围、摘录和来源版本。页码、章节、行号和元素类型只能由 SQLite chunk/element 与 `source-map.json` 计算。

但不能把“模型被提示不要手写页码”当作引用协议。模型仍可能输出 `[Abstract, PDF p.1]` 一类普通 Markdown 文本；它既没有可信 ID，也无法跳转。因此最终协议采用“模型选择证据，Host 生成引用”的职责划分：模型绝不生成论文名、章节、页码、引用序号或 PDF URL。

#### 6.1.2 每轮证据别名与 Agent 工作流

每个论文检索工具结果在原有 `PaperCitation` 之外，增加仅在当前 turn 有效的短别名 `evidence_id`，按返回顺序编号为 `E1`、`E2`、`E3`。`evidence_id` 是模型可读、可选择的句柄，不是 SQLite ID、文件路径或持久 API。

```text
LLM 调用 search_paper_library
  → 返回 E1 / E2 / E3，以及各自的摘要、标题、章节、页码和内部 citationId

LLM 判断候选证据
  → 对需要核对的候选调用 read_paper_section（使用返回的受控 paperId + section 或行范围）
  → 工具结果继续关联同一 evidence_id 或产生新的 E4 …，不暴露任意本地路径

LLM 写最终答案
  → 每个由论文证据支持的句子后只写 `paperagent-cite:E2`
  → 不写 [标题, PDF p.N]、[1]、论文 URL 或自行计算的页码
```

一个句子可带多个别名，例如连续输出 `paperagent-cite:E1` `paperagent-cite:E3`。同一别名在同一回答中重复出现时只生成一个引用编号；编号以其在最终回答中首次出现的顺序决定。模型没有足够证据时应明确说明“本地论文库未找到依据”，而不是添加猜测性引用。

#### 6.1.3 Host 验证、快照与渲染

回答完成时，Host 扫描内部标记并按以下规则生成 `paperagent/citations` Session event；前端将已验证标记渲染为 `[n]`，持久化的回答文本仍保留机器可识别的标记以支持重放：

1. 仅接受同一 turn 实际 `tool/result.presentationMeta` 中登记的 `evidence_id`；未知、跨 turn、重复伪造或格式错误的别名全部丢弃，绝不生成链接。
2. 将 `evidence_id` 映射到真实 `citationId`，再次校验 paper/chunk 属于当前 Session 的 Workspace，并从工具快照取得标题、章节、页码、行号、摘录和论文版本。
3. 在事件中保存不可变 `PaperCitationSnapshot`，并同时记录每一个引用在 assistant 文本中的字符范围/顺序；这使浏览器可以把对应的标记位置替换为行内组件，而不是猜测句子归属。
4. 论文删除或重解析后历史快照仍可显示；预览操作先重新授权当前论文，原文件不存在或不可访问时显示“原论文已删除/不可访问”，不访问历史本地路径。

浏览器的 assistant-message 渲染器按 Host 给出的位置切分正文：普通文本保持原样，合法引用替换为紧随句末的可点击 `[1]`、`[2]` 组件。悬浮卡显示标题、章节、PDF 页码与摘录；点击打开 PaperAgent PDF 右侧预览并跳至该页。回答末尾再渲染“论文引用”列表，作为行内引用的可读补充，而不是唯一入口。

`[Abstract, PDF p.1]` 等人工方括号文本永远不是链接。系统提示词需要明确禁止它；Host 不会尝试从任意自然语言方括号猜测和补造引用，因为这会重新引入错误归因。

建议事件载荷：

```json
{
  "version": 1,
  "assistantMessageId": "…",
  "references": [{
    "evidenceId": "E2",
    "citationId": "pc_…",
    "ordinal": 1,
    "markerStart": 84,
    "markerEnd": 108
  }],
  "citations": [{
    "citationId": "pc_…",
    "paperId": "…",
    "title": "…",
    "section": "…",
    "pdfPage": 4,
    "markdownLineStart": 188,
    "markdownLineEnd": 214,
    "excerpt": "…"
  }]
}
```

已新增 `read_paper_section`：按 paper ID、精确章节或 Markdown 行范围读取有长度上限的正文，用于 Agent 在检索片段不足时继续核对；它不接受任意路径。

#### 6.1.4 实施与验收

1. 扩展文本和结构化元素检索工具的 `presentationMeta`，为每一项生成 turn-scoped `evidence_id`，并让 `read_paper_section`/`read_paper_element` 的结果可继续加入同一证据表。
2. 将当前仅识别 HTML 注释 `<!--paperagent-cite:<citationId>-->` 的 Host 记录器替换为上述行内代码标记 ``paperagent-cite:E…`` 协议；由 Host 统一记录位置、顺序、快照和失效原因，前端只替换已验证的标记。
3. 不渲染回答下方独立 `PaperCitationPanel`；只将已验证 evidence alias 渲染为 assistant-message 内可点击的 `[n]`，并复用同一事件数据支持重放与页级跳转。
4. 为无 PDF、已删除 PDF、跨工作区引用、无效别名、多证据同句、同一证据多次引用和重新解析后的历史回答加入显式 UI 降级。
5. 新增浏览器 E2E：`检索 → 详情核对 → 最终句子 marker → Session event → 行内 [n] → 点击后 PDF 预览跳页`；另覆盖模型输出手写 `[Abstract, PDF p.1]` 时不出现伪链接。

### 6.2 PDF 定位与预览

原 PDF 保持在受管目录 `.paperagent/papers/<paperId>/original.pdf`，但浏览器绝不能接收该路径或使用 `file://`。新增经过当前 DSH Session 与 Workspace 授权的 PDF 二进制路由，例如 `GET /api/paperagent/papers/:paperId/pdf`：仅允许已归档且归属当前工作区的论文，响应 `application/pdf`、`Content-Disposition: inline`，支持 HTTP Range；拒绝未授权、已删除或无 PDF 的论文。

浏览器使用 `pdfjs-dist` 实现共享 `PaperPdfViewer`，支持按 `pdfPage` 跳页、翻页、缩放、加载/错误状态和“全屏阅读”。当前只提供页级定位并同时显示章节和摘录；不保存 MinerU bbox，也不提供 PDF 原文坐标高亮。

## 7. UI 主路线

左侧栏“新对话”下方已有：

- 论文库：替换右侧对话区域为论文管理页面。
- 新对话：回到 DSH 对话区域。

论文库页面的当前职责：论文库的新建/改名/删除、PDF 与 BibTeX 导入、论文详情、更新 PDF/BibTeX、删除论文、解析/重试和解析状态列。论文标题是列表主字段，不能显示临时上传文件名或 hash 作为标题。

### 7.1 arXiv 一键导入

“新建论文”对话框提供 arXiv URL 输入框。仅接受 `https://arxiv.org/abs/<id>`、`https://arxiv.org/pdf/<id>.pdf`（及官方 `www`/`export` 子域）的 URL；服务端从编号构造固定的 arXiv Atom 元数据和 PDF 下载地址，不请求用户输入的任意下载地址。导入时下载 PDF、从 Atom 条目读取标题、作者、年份、摘要、DOI 和分类、生成并保存 BibTeX，归档到当前选择的论文库后立即创建现有 MinerU 解析任务。PDF 哈希重复时不覆盖既有论文或重复解析。

### 7.2 对话引用与论文阅读器

目标交互是：对话中的引用显示为正文内 `[1]`、`[2]`。Host 会验证同 turn 工具结果发出的 evidence alias；只有验证通过的行内代码标记才会渲染为 `[n]`。点击正文引用时，在对话右侧打开 `PaperPdfPreviewDrawer`，自动定位至对应 PDF 页，并保留对话上下文；不再占用额外的参考文献卡片空间。

抽屉默认宽度 420–520px，顶部显示标题、章节、页码、关闭按钮和“全屏阅读”。右侧同时显示命中摘录，帮助用户在页内核对；引用只跳转到目标页，不宣称已高亮原文。点击“全屏阅读”打开覆盖整个 DSH 内容区的 `PaperPdfFullscreen` 阅读层，复用同一 `PaperPdfViewer`；退出全屏回到右侧预览。论文库详情页也提供“预览 PDF”入口。BibTeX-only 论文显示无 PDF 状态而不创建空预览。

### 7.3 解析结构可视化

论文列表中的“解析完成”状态需要成为可点击入口。点击后打开一个 DSH 风格的宽对话框，以层级树展示当前解析 revision 的 Section，并在每个 Section 下列出其正文 child chunks。该功能只读，不修改解析结果、索引状态或 Markdown 文件；不修改 DSH 核心的 Agent Loop、Session 或轨迹实现。

#### 7.3.1 交互与展示

1. 只有 `parseStatus=ready` 的“解析完成”可以点击；`metadata`、`queued`、`parsing`、`failed` 和 `cancelled` 状态显示为普通状态，不打开结构窗口。
2. 点击状态单元格时必须阻止列表行事件冒泡，不能同时打开论文详情；状态请求失败时在当前对话框显示错误，不覆盖论文列表错误。
3. 对话框标题为“论文切分结构”，顶部显示论文标题、当前 `revisionId`、解析时间、Section 总数和 Chunk 总数。
4. Section 使用可展开/折叠的树形结构，按 `readingOrder` 排列；每行显示标题、层级、PDF 页码范围、Markdown 行范围和 Chunk 数量。
5. 每个 Section 内显示按 `sequence` 排序的 Chunk 列表。Chunk 行显示序号、页码、Markdown 行号、字符数、关联元素数量以及受限长度的文本预览。
6. 默认只展开第一层 Section，其余节点折叠；对话框内容区域独立滚动。首版使用原生 `details/summary` 或 DSH 已有折叠原语，不新增树组件依赖。
7. Chunk 首版只返回约 300–500 字符的 `contentPreview`，避免打开长论文时传输整份 Markdown；完整 Chunk 内容按需能力留作后续 `read_paper_chunk` 扩展。

展示结构如下：

```text
论文切分结构
├─ 1 Introduction                         2 chunks
│  ├─ Chunk 1 · PDF 1-2 · Markdown 5-16   文本预览...
│  └─ Chunk 2 · PDF 2   · Markdown 17-28  文本预览...
├─ 2 Related Work                         4 chunks
│  ├─ 2.1 CNN-based Methods                2 chunks
│  │  ├─ Chunk 1                           文本预览...
│  │  └─ Chunk 2                           文本预览...
│  └─ 2.2 Transformer Methods              2 chunks
└─ 3 Method                               8 chunks
```

#### 7.3.2 Remote 契约与返回模型

新增浏览器只读 Remote 方法：

```ts
getPaperParseStructure(
  sessionId: string,
  paperId: string,
): Promise<Reply<PaperParseStructure>>
```

`PaperParseStructure` 应在 `contracts` 和 UI `api-types.ts` 中共享，建议定义为：

```ts
interface PaperParseStructure {
  paperId: string
  title: string
  revisionId: string
  parsedAt: string | null
  sectionCount: number
  chunkCount: number
  sections: PaperSectionNode[]
}

interface PaperSectionNode {
  id: string
  title: string
  path: string
  level: number
  parentId: string | null
  pdfPageStart: number
  pdfPageEnd: number
  lineStart: number
  lineEnd: number
  chunkCount: number
  chunks: PaperChunkPreview[]
  children: PaperSectionNode[]
}

interface PaperChunkPreview {
  id: string
  sequence: number
  pdfPageStart: number
  pdfPageEnd: number
  lineStart: number
  lineEnd: number
  charCount: number
  contentPreview: string
  elementCount: number
}
```

返回值必须来自当前论文的 ready revision。不得让浏览器传入本地文件路径，也不得把 `bbox`、API Key 或完整本地目录暴露给客户端。

#### 7.3.3 Domain 查询实现

在 `packages/domain` 中增加 `getPaperParseStructure(workspacePath, paperId)`，执行以下步骤：

1. 根据 workspace 和 paper ID 读取论文，并校验论文存在且解析状态为 `ready`。
2. 读取当前 revision 的 `paper_sections`，按 `reading_order` 排序。
3. 读取当前 revision 的 `paper_chunks`，按所属 `section_id`、`sequence` 和 `line_start` 排序。
4. 通过一次聚合查询统计每个 Chunk 的 `paper_chunk_elements` 关联数量，不能为每个 Chunk 单独查询。
5. 将 Section 按 `parent_id` 组装成树，把 Chunk 挂载到直接所属 Section；不把父 Section 的全文复制成 Chunk。
6. 对 Chunk 内容生成固定上限的 `contentPreview`，保留真实字符数、页码和 Markdown 行号。
7. 对没有可用章节树的论文返回明确的 `structureAvailable=false` 或领域错误，提示重新解析；不得在 UI 层猜测旧章节标题。

Domain 查询只读取 SQLite，不读取任意用户路径，也不访问 MinerU、Embedding 或 Elasticsearch。这样结构页面在索引尚未完成时仍可打开。

#### 7.3.4 Tools Remote 与安全边界

在 `packages/tools/src/remote.ts` 中注册 `getPaperParseStructure`：

- 从 `sessionId` 映射当前 DSH Workspace；
- 校验论文属于该 Workspace；
- 调用 Domain 查询并映射为浏览器 DTO；
- 只返回受限预览文本和坐标字段；
- 不接受 `workspacePath`、`revisionPath` 或任意文件名参数。

该接口属于 PaperAgent 插件的领域 Remote，不需要新增 DSH Core 服务，也不需要把结构注册为 Session event。

#### 7.3.5 UI 实现与源码边界

继续在现有 `packages/ui/src/client/Library.tsx` 中集中管理，不新增 `pages`、`shared` 或 `components` 目录。增加以下状态和逻辑：

```text
structurePaperId
parseStructure
parseStructureLoading
parseStructureError
openParseStructure()
closeParseStructure()
```

在 `Library.tsx` 中增加 `ParseStructureDialog` 和递归 `SectionNode`/`ChunkRow` 渲染；样式放入现有 `Library.module.css`，复用 `Modal`、`Button` 及 DSH 基础字体、边框和颜色。Modal 建议宽度 900–1100px、最大高度约 `80vh`，内容区独立滚动。

重新解析时应关闭结构窗口并清理缓存；新的 revision 变为 ready 后再次点击重新请求。请求需要使用 paper ID/revision 进行过期校验，避免旧请求覆盖用户当前选择的论文。

#### 7.3.6 性能、错误和验收

- Domain 使用固定的 Section/Chunk/关联统计查询，避免 N+1。
- 结构结果按 `paperId + revisionId` 短期缓存；重新解析后主动失效。
- 大论文默认折叠节点，首版不要求虚拟列表；超过约 1000 个 Chunk 时保留预览截断和独立滚动，后续再增加懒加载。
- 解析完成但 Embedding/Elasticsearch 仍为 queued 或 processing 时，结构窗口必须正常显示。
- 解析失败、论文不存在、没有当前 revision 或 Remote 请求失败时，显示可理解的空态/错误，不出现白屏。

验收至少覆盖：

1. 一级、二级、三级 Section 的父子层级正确；
2. 每个 Section 的 Chunk 顺序、页码和 Markdown 行号正确；
3. 短段落合并后的 Chunk 仍只挂在一个 Section 下；
4. 结构化元素数量与 `paper_chunk_elements` 关联一致；
5. 解析中、解析失败和 BibTeX-only 论文不可误打开；
6. 重新解析后窗口显示新 revision，不残留旧缓存；
7. 不同 Workspace 之间无法读取对方论文结构；
8. Modal、树节点和内容区域符合 DSH 样式并可独立滚动。

### 7.4 UI 源码组织约束

`packages/ui/src/client` 已收敛为单层目录，按完整业务模块命名，不新增 `pages`、`shared`、`components`、`hooks` 等目录，也不在文件名中使用这类分层词或重复的 `PaperAgent` 前缀。`Library.tsx` 统一承载论文库切换、列表与选择、BibTeX 导出、新建/编辑/详情/删除/移动、MinerU 解析状态和预览入口；`Pdf.tsx` 统一承载连续滚动、缩放、全屏、目标页定位和返回导航；`Citations.tsx` 统一承载行间 token 解析、编号渲染和点击跳转。`Views.tsx`、`SidebarAction.tsx`、`MineruSettings.tsx` 分别负责宿主集成、侧栏入口和设置集成；`api-types.ts`、`remote.ts`、`navigation.ts`、`ui-utils.ts` 等仅因跨模块复用而独立，并与业务模块同级。模块专属文件低于约 80--100 行时应合并回所属模块，只有真正复用或具有独立生命周期的渲染适配器才保留为同级文件。具体迁移记录以 [cleanup-refactor-plan.md 第 8 节](./cleanup-refactor-plan.md#8-ui-业务模块合并与异步生命周期) 为准。

## 8. 后续交付顺序

| 优先级 | 交付 | 完成标准 |
| --- | --- | --- |
| P0-1 | SQLite FTS5 与受控精确检索 | 已完成：FTS5/BM25、中文 n-gram 补充、过滤与受限精确 Markdown 搜索；不可用时词法检索降级 |
| P0-2 | Agent 证据闭环与页级定位 | 实现完成、待浏览器验收：`read_paper_section`、同 turn evidence alias 校验、`paperagent/citations` Session event、行内 `[n]`、无 PDF 降级、受控 PDF URL、右侧预览与页级跳转均已实现；产品不再渲染回答下方参考卡片，仍需浏览器 E2E。 |
| P1-1 | 论文阅读增强与图片资产 | 已完成：覆盖式 `PaperPdfFullscreen`、连续 PDF.js 阅读/缩放、MinerU ZIP 安全提取受管图片、`paper_figures`/FTS；论文详情按产品约束不展示图片预览 |
| P1-2 | 结构化元素索引 | 已完成：新增 `paper_elements`、`paper_elements_fts`、`paper_chunk_elements`，生成 source-map v4，支持 figure/table/equation 独立定位与检索；已补充 Domain/Parser/Tools/Remote 测试 |
| P1-3 | DeepSeek 图片描述与图片检索 | 已完成：`PaperVisionJobs`、结构化描述、去重/重试/失败隔离、图片 FTS，以及可定位 PDF 页的图表引用 |
| P1-4 | DSH 原生图片对话配置 | 已提供部署样例 [deepseek-vision.settings.example.yml](../config/deepseek-vision.settings.example.yml)：通过 DSH `llm-pi-ai` 设置注册视觉路由，凭据仍由 DSH 管理；需由部署者在其 DSH 设置中启用 |
| P1-5 | PaperAgent 统一研究 Skill | 已完成：保留专用 `paper-import`，新增运行时 `paper-research`，统一导入、文本/元素检索、正文核对和 evidence 引用工作流；全部 PaperAgent Skill 采用“同目录 `SKILL.md` 正文 + `*-skill.ts` 运行时注册器”结构，并在构建时复制资源至 `lib`。 |
| P1-6 | PaperAgent LaTeX 写作与润色 Skill | 已完成首版：新增运行时 `paper-writing` 与受 Workspace/20 条上限保护的 `read_paper_bibliography`；Skill 固化 draft/polish/cite/latex-fix、PaperAgent 证据核对、`.bib` 去重/冲突停机、`\cite{}` 最小插入、禁止写入聊天 evidence token 和安全编译规则。与其余 Skill 一致使用 `SKILL.md` 正文及运行时注册；已补 Domain、Skill 与构建资源回归测试。LaTeX 工作区 E2E fixture 留作后续验收。 |
| C0-C6 | 代码清理、模块拆分与 DSH 扩展收敛 | 详见 [cleanup-refactor-plan.md](./cleanup-refactor-plan.md)：先建立基线和 noUnused 门禁，再拆分 Domain、Parser、Tools、Remote、UI，最后将 DSH 改动收敛为通用扩展点；C6 未完成前不启动 P2。 |
| P2-1 | Embedding/ES 抽象与配置 | 已完成：`@paperagent/retrieval` 默认 SQLite 召回；`@paperagent/retriever-elasticsearch` 安全连接测试、版本化 dense-vector 索引写入；`@paperagent/embedding-dashscope` qwen3-vl-embedding 文本/融合请求；SQLite `paper_embedding_jobs`、解析后 worker、设置开关、连接测试、索引状态与手动重建均已落地。 |
| P2-2 | DashScope 文本/融合 embedding | 已完成首版：chunk、figure/table/equation 可生成向量；维度、MIME、超时、重试和脱敏错误受限。 |
| P2-3 | Elasticsearch 索引与同步 | 已完成首版：Docker 单节点、workspace 过滤、幂等 upsert、单篇重建前清理旧 revision 的派生文档与可见索引；后续补 alias 切换和全量 reconcile。 |
| P2-4 | Hybrid RAG 检索接入 | V1 已完成：正文 chunk、结构化 element（图/表/公式）和 figure 的 ES kNN + SQLite FTS5 并行召回、SQLite hydrate、RRF 融合、ES/Embedding 故障回退；引用/evidence 契约不变。 |
| P2-6 | 会话级检索视图 | 已完成实现、待浏览器验收：正文、元素、图片检索持久化 `paperagent/retrieval-trace`；插件以 `conversation.view` 注册“检索”主标签，展示当前 Session 的检索列表、阶段详情与 PDF 跳转。试验性的 DSH `tool-detail` / 轨迹详情扩展已删除。 |
| P2-5 | 图片向量检索与评测 | image → figure 反向检索、Recall@k 对比、隐私提示和浏览器验收 |
| P2-7 | DashScope Rerank 精排 | 首版已实现：RRF/SQLite 候选集之后调用 qwen3-rerank 或 qwen3-vl-rerank；SQLite/Hybrid 均可复用；检索轨迹展示 rerankScore；DashScope 失败回退原顺序。真实 VL 图片配额和线上账号验收仍待完成，详见第 12 节 |
| P2-8 | 分层 Section 与自适应子 chunk | 源码首版已实现：新增 `paper_sections` 章节树和 `section_id`，以自然段为最小边界，通过待合并栈合并短段落、按句子拆分长段落；source-map 升级 v5；FTS/ES 只索引子 chunk，章节读取支持递归 descendants；已有论文需统一重新解析和重建索引 |
| P2-9 | 解析结构可视化 | 已实现：点击论文列表“解析完成”打开 DSH 风格结构对话框；按 Section 层级展示 Chunk 列表、页码、Markdown 行号和截断文本预览；新增 `getPaperParseStructure` Remote；不修改 DSH Core；Domain/Remote/UI 已完成，跨 Workspace 由 session 解析并在切换时清理弹窗状态 |

## 9. 测试与验收

| 层次 | 必测行为 |
| --- | --- |
| Domain | Workspace 隔离、SHA-256 去重、论文库/论文 CRUD、删除范围、chunk/element/figure 与 FTS 同步、视觉任务状态独立性 |
| Parser | MinerU 凭据脱敏、签名上传、轮询、ZIP 安全、带原文件名前缀的 content list、文本/公式/表格/图元素标准化、source-map v5、受管图片提取与原子回滚；已实现 section 树、短段落合并栈、长句降级、元素邻近 chunk 关联 |
| Retrieval | 文本和元素 FTS 排序、中文短语、英文术语、类型/章节/论文/论文库过滤、FTS5 不可用降级、精确搜索路径与正则安全；P2-4 增加 kNN workspace/revision 过滤、SQLite hydrate、RRF 去重/排序、ES 与 embedding 故障回退；P2-8 增加 section descendants 过滤、子 chunk 上下文扩展和父子结果去重 |
| Tools | 参数上限、Workspace 归属、无证据回答、`read_paper_section`/`read_paper_element` 长度限制、图表/公式搜索读取、citation ID 只能来自本 turn 工具结果、citation 快照字段完整性；P2-6 增加 trace 与 callId 一一对应、候选截断、敏感字段不持久化 |
| Skills | `paper-import` 与 `paper-research` 注册、适用场景、工具选择顺序、无本地证据降级、元素检索后正文核对、evidence 引用约束 |
| LaTeX Writing | `paper-writing` 四种模式、`.bib` 目标解析、条目去重与 citation-key 冲突、`\cite{}` 插入、禁止写入聊天 evidence token、项目既有编译命令、日志/PDF 验证与安全失败 |
| UI | 左侧入口、返回对话、每行解析状态、论文 CRUD、Token 只写、图片状态/预览/重试、正文行内引用、引用点击打开右侧预览并定位页码、全屏阅读回退；P2-6 增加会话级“检索”主标签、检索列表、阶段详情、回退状态、Session 隔离与 PDF 跳转；P2-9 增加“解析结构”对话框、Section/Chunk 树、预览截断、加载/错误/空态和独立滚动 |
| PDF Route | Session/Workspace 授权、禁止本地路径泄露、Range 请求、已删除/BibTeX-only/未授权论文的安全失败、页级定位 |
| Vision | 仅视觉模型接受图片、DeepSeek 请求 MIME/Data URL、JSON schema、超时/重试/去重、失败不影响论文 ready 状态、密钥与图片请求体不落日志 |
| Embedding | DashScope 文本/图片/融合请求、模型与维度白名单、批处理/限流/429 重试、MIME/Base64 校验、密钥和图片请求体不落日志 |
| Elasticsearch | Docker 单节点、dense_vector mapping、版本化 alias、workspace 过滤、幂等同步、删除/重建、不可用时 SQLite 回退 |
| Multimodal Retrieval | 文本 → figure/table/equation、image → figure（V5）、混合排序、旧 revision 隔离、结果 hydrate 与 citation 不变 |
| E2E | 待补：导入 PDF → MinerU → `paper.md`/source map/chunks/elements/images → 视觉描述 → 文本、图、表、公式检索 → Agent 回答 → 行内可点击引用；DSH 图片对话附件 → DeepSeek Vision → 回答。当前仅有 Node 层 fixture/契约测试，不能视为浏览器或真实 MinerU 验收。 |

验收重点不是“能搜到一段文本”，而是每个回答中的论文事实都能回到同一 Workspace 的论文、章节、PDF 页码和 Markdown 行号。

## 10. 运行与安全

开发后必须先构建 bundle：

```powershell
Set-Location D:\workspace\paperagent-dsh
corepack pnpm run check
corepack pnpm run build

Set-Location ..\deepseek-harness
corepack pnpm dsh web --port 3091
```

启用 Elasticsearch 扩展的本地验收步骤（仅在用户明确开启配置后执行）：

```powershell
Set-Location D:\workspace\paperagent-dsh
cd infra/elasticsearch
docker compose up -d
```

确认 `node` 仅监听 `127.0.0.1`，再在 PaperAgent 设置中执行“连接测试”和“重建索引”。停止开发服务时使用普通 `docker compose stop`；不要在常规流程中执行带 `-v` 的停止命令，以保留本地索引卷。ES、DashScope 均不可用时，插件必须继续使用 SQLite FTS5 完成检索。

## 11. 联网论文发现、二进制下载与标准化导入计划

本节覆盖 7.2 中仅支持 arXiv URL 的早期范围：目标不是新增一个独立的 acquisition 插件，也不修改 DSH core；而是在唯一的 `@paperagent/dsh-paperagent` 插件内部补齐“论文发现 → 可靠下载 → 入库”的 Host 能力。最终边界如下：DSH 提供搜索、可选网页正文抓取、会话、Agent Loop、Skill 与受控文件系统等通用原子能力；PaperAgent 负责论文来源适配、公开二进制下载、PDF/BibTeX 导入、去重、解析和检索。

### 11.1 目标、非目标与分层

必须支持用户在对话或论文库页面中以论文题目、DOI、arXiv URL、论文落地页 URL 或公开 PDF URL 发起导入。系统在证据充分时自动获得 PDF 和 BibTeX；PDF 与 BibTeX 任一项缺失时允许降级导入另一项，但必须明确说明缺失原因和下一步操作。所有下载成功的论文都复用现有 SQLite、受管文件目录、SHA-256 去重和 MinerU 解析任务，不创建第二套持久化或解析链路。

不实现 Google Scholar 爬虫、Cookie/账号登录、付费墙绕过、反爬绕过、通过 LLM 臆造 BibTeX 或从不可信 HTML 猜测论文元数据。`web_fetch` 的定位是网页正文抓取，不是 PDF 二进制下载器；不能把 PDF 下载、临时文件写入或文件签名校验交给它。

```text
用户题目 / DOI / URL
        ↓
paper-import Skill：识别输入、调用 DSH 原子能力、核验和确认
        ↓
DSH web_search：发现候选来源（题目输入时）
DSH web_fetch：可选读取公开落地页（仅在启用且确有必要时）
        ↓
PaperAgent Host：来源适配器 → 安全二进制下载器 → 导入服务
        ↓
domain：SQLite / 受管文件 / SHA-256 去重
        ↓
MinerU：异步解析 → Markdown / source map / chunks / elements
```

### 11.2 DSH 原子能力的复用策略

`web_search` 是题目发现的默认能力，复用 DSH 基础组合中已有的 DeepSeek 搜索提供方和 `DEEPSEEK_API_KEY`。Skill 对题目构造精确查询，例如精确标题、第一作者、年份、`site:arxiv.org`、DOI 或公开 PDF 线索；它不得把搜索结果直接当作论文身份，而必须核对标题、作者、年份或 DOI。

`web_fetch` 仅用于需要读取候选落地页文本、寻找 DOI 或显式 BibTeX 链接的情况。当前 DSH 默认禁用该工具；启用时需在部署 patch 中挂载 `@deepseek-ai/dsh-web-fetch-http` 并将 `@deepseek-ai/dsh-tool-web` 的 `fetch` 设为 `true`。其请求目标由 Agent 决定，而本地 HTTP provider 不拦截私网目标，因此默认保持关闭；若启用，Skill 必须只传递经过 `web_search` 或用户确认的公开 HTTPS 候选 URL，PaperAgent 自己的下载器仍要执行完整的 SSRF 防护。

DSH Skill 只保存决策和调用规则，不能承担安全边界。二进制下载、文件校验、重定向验证、原子落盘、下载失败清理与领域去重必须由 PaperAgent 的 TypeScript Host 代码实现并可测试。

### 11.3 PaperAgent 内部实现结构

不新增 Cordis 插件、bundle 或新的运行时包。仅在既有 `packages/tools` 中增加内部模块，`plugin.ts` 继续是唯一的 Agent 工具注册入口，`remote.ts` 继续是浏览器 Remote 入口；二者都调用同一个导入服务。

```text
packages/tools/src/
  plugin.ts                         # Agent 工具、系统提示词、Skill 触发提示
  remote.ts                         # 论文库 UI Remote
  import/
    paper-import-service.ts         # 编排：解析来源、下载、导入、启动 MinerU
    binary-downloader.ts            # 受限 HTTPS 二进制下载与临时文件生命周期
    source-types.ts                 # Adapter / Candidate / Asset / Provenance 契约
    adapter-registry.ts             # 适配器优先级与统一解析入口
    adapters/
      arxiv.ts                      # 官方 Atom 元数据 + 固定 PDF
      doi.ts                        # Crossref 元数据 + OpenAlex OA PDF 补充
      venue-pdf.ts                  # OpenReview / ACL Anthology / CVF 固定公开入口
      direct-pdf.ts                 # 普通 HTTPS PDF 的明确降级
  agent-tools/
    resolve-paper-reference.ts
    import-resolved-paper.ts
```

现有 `importArxivPaperIntoWorkspace()`、`importPdfUrlIntoWorkspace()` 与下载辅助函数迁移到 `paper-import-service.ts` / `binary-downloader.ts`，保持对 UI Remote 和已有 Agent 工具的兼容包装。迁移后 `domain` 仍只接受本地受管文件或 BibTeX 文本并执行领域写入；它不得访问网络、解析网页或判断外部站点。

### 11.4 统一来源适配器契约

每个适配器只识别自己负责的稳定来源，并返回结构化候选；不得直接写 SQLite、创建 MinerU 任务或自行绕过下载器。适配器优先级固定为：arXiv → DOI/可信元数据 → OpenReview/ACL/CVF 等专用站点 → 普通公开 PDF。

```ts
interface PaperSourceAdapter {
  readonly id: string
  canHandle(reference: NormalizedPaperReference): boolean
  resolve(reference: NormalizedPaperReference, context: ResolveContext): Promise<PaperCandidate[]>
}

interface PaperCandidate {
  readonly source: string
  readonly canonicalUrl: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year: number | null
  readonly doi: string | null
  readonly confidence: 'high' | 'medium'
  readonly pdf: { url: string; provenance: string } | null
  readonly bibtex: { text: string; provenance: string } | null
  readonly metadataProvenance: readonly string[]
}
```

具体规则：arXiv 使用官方 Atom 元数据和固定 PDF URL，并从权威字段生成 BibTeX；DOI 适配器规范化 DOI，再以 DOI/Crossref 元数据生成或取得 BibTeX，PDF 仅使用明确的开放获取候选；OpenReview、ACL Anthology、CVF 适配器读取各自稳定的公开 PDF/BibTeX 入口；`direct-pdf` 只承诺 PDF，除非用户同时提供 BibTeX 或已有可靠 DOI 证据。OpenAlex 用于补充开放获取 PDF 候选和元数据，不能单独成为身份匹配依据。

当多个候选的标题、作者或年份无法唯一匹配时，服务返回候选列表而不是下载；Skill/界面必须要求用户选择。每个候选都保留来源 URL、适配器 id 和置信度，以便显示、审计和失败诊断。

### 11.5 安全二进制下载器

`binary-downloader.ts` 是 PaperAgent 内部唯一允许写入下载内容的模块。它仅接受公开 HTTPS URL，不发送 Cookie、Authorization 或用户自定义敏感请求头；拒绝 URL 用户信息、非 HTTPS、空响应和超过配置上限的资源。每一次重定向都必须重新验证协议、DNS/IP 地址和目标 URL，拒绝回环、私网、链路本地、保留地址与不安全协议；重定向次数、响应头大小、总下载字节数、连接/读取超时均受配置限制。

下载先写入 `<workspace>/.paperagent/staging/<operation-id>/` 下的 `.part` 文件，流式计算 SHA-256 和字节数。PDF 成功条件至少包括 `%PDF-` 文件签名、非空内容、上限校验和安全文件名；BibTeX 成功条件至少包括 UTF-8/可识别文本与有效 `@<entry>{...}` 条目。校验通过后才把本地临时路径交给领域导入服务；无论成功、重复、取消或异常，操作完成后都清理 staging 目录。真实归档位置仍由 domain 统一决定为 `<workspace>/.paperagent/papers/<paper-id>/original.pdf`。

下载配置放在现有 `paperAgent` 插件配置下，例如 `maxPdfBytes`、`downloadTimeoutMs`、`maxRedirects`、`maxMetadataBytes` 与各适配器的启用开关；其中不保存任何 API Key。未来某一数据源要求 API Key 时，必须仿照 MinerU 通过 DSH credentials 引用，而不是写入 YAML 或 SQLite。

### 11.6 Agent 工具与 UI Remote

Agent 侧提供两个面向工作流的高层工具：

```text
resolve_paper_reference(reference, search_evidence?)
  → 候选论文（含稳定 candidate_id）、标题/作者/DOI、PDF/BibTeX 可用性、来源与置信度

import_resolved_paper(reference, candidate_id, library_id)
  → 下载、校验、导入、去重、解析任务状态与完整 provenance
```

低层能力继续保留给 UI、恢复操作和手动场景：`import_paper_pdf_file`、`import_paper_bibtex_text`、`attach_pdf_to_paper`、`attach_bibtex_to_paper`、`start_paper_parse`。高层工具不向模型暴露 staging 路径，也不要求模型把二进制内容编码进工具参数。

论文详情与 SQLite 增加可追溯但不含敏感数据的来源字段：`canonical_url`、`pdf_source_url`、`bibtex_source_url`、`source_adapter`、`metadata_provenance_json`、`imported_at`。论文详情页只读展示这些来源；编辑页仍只允许替换 PDF、替换 BibTeX 和手动修正元数据。论文库“新建论文”对话框后续增加“按题目 / DOI / URL 导入”入口，展示候选列表、来源、PDF/BibTeX 可用性和目标论文库，用户确认后才开始下载。

### 11.7 内置 `paper-import` Skill

Skill 随 PaperAgent 分发，不创建独立插件或依赖开发机目录。插件启动时通过 DSH `skills.register()` 注册运行时资源，名称固定为 `paper-import`，对模型和用户可调用；资源内不得包含密钥、工作区绝对路径或网站爬虫脚本。

Skill 中规定以下强制工作流：

1. 先读取用户指定的目标论文库；未指定时使用“未分类”或请求确认。
2. arXiv URL 直接调用 `resolve_paper_reference`；不必先调用搜索。
3. DOI、论文页 URL 或直接 PDF URL 先规范化，再调用解析工具；题目输入先调用 DSH `web_search` 取得候选公开来源，再将来源证据传给解析工具。
4. 必须比较标题、第一作者、年份和 DOI；存在多个候选、同名文献或中等置信度时展示候选并等待用户选择。
5. 不要求 Agent 直接下载文件；确认后仅调用 `import_resolved_paper`。下载失败时说明来源、阶段和可恢复建议，不能伪造成功。
6. BibTeX 只能来自 arXiv/DOI/可信适配器/用户输入；无可靠来源时允许 PDF-only 导入，并明确标为“缺少 BibTeX”。
7. 导入完成后返回论文标题、论文库、PDF/BibTeX 来源、是否为重复项以及 MinerU 解析状态。

### 11.8 分阶段实施与验收

| 阶段 | 实施项 | 完成标准 |
| --- | --- | --- |
| I1 | 抽取现有 arXiv / 直链 PDF 下载逻辑为 `paper-import-service` 与 `binary-downloader` | 已完成：UI / Agent 兼容包装统一通过导入服务；domain 不访问网络 |
| I2 | 下载器安全边界与 staging 生命周期 | 已完成第一版：HTTPS、URL 凭据、私网 DNS/IP、重定向、大小、超时和 `%PDF-` 校验；每次操作在受管 staging 下清理 |
| I3 | 适配器注册表与 arXiv / DOI / Crossref / direct-PDF 适配器 | 已完成：arXiv PDF+BibTeX，DOI 的 Crossref 元数据/BibTeX 与 OpenAlex OA PDF，直链 PDF 降级 |
| I4 | Agent 高层工具与 `paper-import` Skill | 已完成：`resolve_paper_reference`、`import_resolved_paper` 和运行时 `paper-import` Skill；题目发现强制先走 DSH `web_search` |
| I5 | OpenAlex、OpenReview、ACL、CVF 适配器与 provenance 持久化 | 已完成首批：OpenAlex 用于 DOI 的 OA PDF，OpenReview/ACL/CVF 有固定公开路由；SQLite 保存和详情展示来源。后续站点变更只降级为直接 PDF，不影响既有论文 |
| I6 | 论文库导入 UI | 已完成：选择论文库、解析候选、显示来源/PDF/BibTeX/置信度、用户确认后导入，并在原有解析状态列观察 MinerU |

测试除现有 Domain、Parser、Tool 与 E2E 覆盖外，新增适配器 fixture 测试、流式下载/重定向/SSRF 测试、staging 清理测试、来源 provenance 迁移测试、Skill 指令回归测试，以及“题目搜索 → 用户确认候选 → 下载 PDF/BibTeX → 去重 → MinerU”完整端到端测试。

生产/日常使用安装 `packages/bundle`，不要仅使用 Host source patch；浏览器端页面需要 bundle 中的 `dsh.client`。解析会把 PDF 发送到用户配置的 MinerU 服务；启用视觉功能后，论文图片和 DSH 对话附件会发送至 DeepSeek 官方 API；启用向量扩展后，参与 embedding 的文本、图注和图片还会发送至配置的 DashScope API。页面应持续提示这三个云端处理边界，并允许用户单独关闭视觉描述或向量索引。
## 12. DashScope Rerank 精排实现与后续验收

### 12.1 当前状态与目标

当前版本在 `packages/retrieval/src/index.ts` 中先通过 `fuse` 完成 RRF 候选融合，再由可选的 `RerankingPaperRetriever` 调用 DashScope 完成最终精排。本节记录已实现边界与后续线上验收项。

目标是在已有 SQLite FTS + Elasticsearch kNN 召回之后增加可选的 DashScope 精排：

~~~text
SQLite FTS + Elasticsearch kNN
        ↓
候选去重并从 SQLite hydrate 当前 revision
        ↓
RRF 融合，保留前 candidateLimit 条
        ↓
DashScope Rerank 精排
        ↓
最终 topN → evidenceId → PaperCitation → 行内引用
~~~

Rerank 不替代 SQLite、Elasticsearch、精确章节读取或引用校验。SQLite 仍是论文事实和引用坐标的唯一来源；Elasticsearch 仍是可重建的派生召回索引；Rerank 只改变候选排序。

官方文档：

- [DashScope 重排序](https://help.aliyun.com/zh/model-studio/rerank)
- [DashScope 文本排序 API](https://help.aliyun.com/zh/model-studio/text-rerank-api)

### 12.2 模型和批次路由

首版默认使用 `auto` 路由：纯文本候选调用 qwen3-rerank。它适合正文 chunk、表格、公式，以及已经转换为文本的图片 caption/visionDescription。

只有在同一个候选批次必须携带真实图片，或者查询本身是图片时，才使用 qwen3-vl-rerank。该模型支持文本、图片和视频混合输入，但多模态请求不能使用 OpenAI 兼容接口，必须使用 DashScope 原生接口。

路由规则：

~~~text
查询和候选都是文本
        → qwen3-rerank

查询是图片，或候选批次包含真实图片
        → 整批使用 qwen3-vl-rerank

图片不可读、超过大小限制或未开启图片出站
        → 将 figure 降级为 caption + visionDescription + nearbyText
        → 若当前模型为 qwen3-rerank，继续文本精排；若配置的是 qwen3-vl-rerank，则以文本文档调用其原生接口
~~~

禁止把同一批候选拆成文本请求和图片请求后，直接比较两次返回的 relevance_score。官方定义的 relevance_score 主要用于当前请求内排序，不是跨请求的绝对分数。若未来确实要拆批，必须单独设计校准数据和分数归一化；首版不实现。

### 12.3 API 请求封装

新增独立包：

~~~text
packages/reranker-dashscope/
  src/index.ts        # endpoint、请求、超时、响应 decoder 和对外导出 PaperReranker
~~~

通用契约：

~~~ts
interface RerankDocument {
  readonly sourceId: string
  readonly text: string
  readonly imageDataUri?: string
}

interface RerankResult {
  readonly sourceId: string
  readonly index: number
  readonly relevanceScore: number
}

interface PaperReranker {
  rerank(input: {
    readonly query: { readonly text?: string; readonly imageDataUri?: string }
    readonly documents: readonly RerankDocument[]
    readonly topN: number
    readonly instruct?: string
  }): Promise<readonly RerankResult[]>
}
~~~

qwen3-rerank 使用：

~~~text
POST https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks
Authorization: Bearer <DASHSCOPE_API_KEY>
~~~

请求体为同层级的 model/query/documents/top_n/instruct。响应中 results[].index 对应输入 documents 的下标，results[].relevance_score 为相关性分数。

qwen3-vl-rerank 使用：

~~~text
POST https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
Authorization: Bearer <DASHSCOPE_API_KEY>
~~~

请求体为 model/input/parameters，其中 input.query 和 input.documents 可以携带 text、image 或 video。本地图片只能转换为受限大小的 Base64 Data URI 后发送，不能发送本地绝对路径。

响应 decoder 必须校验：

1. HTTP 状态和 DashScope 错误对象；
2. results 是否为数组；
3. index 是否在输入范围内且不重复；
4. relevance_score 是否为有限数；
5. 返回数量是否不超过 topN；
6. 文档数量、图片 MIME/大小和本地请求上限；DashScope 仍会对 token 配额做最终校验。

### 12.4 候选文档构造

Rerank 文本不能只传裸 chunk，应由 retrieval 层构造带边界的文本：

~~~text
[Title]
论文标题

[Section]
章节标题

[Type]
chunk / figure / table / equation

[Caption]
元素 caption

[Content]
正文、表格 Markdown 或公式 LaTeX

[Context]
已按照结构优先规则选择的附近正文

[Vision description]
figure 的 DeepSeek 视觉描述（如果存在）
~~~

不同类型的候选：

- chunk：标题、章节和正文；
- table：标题、caption、规范化表格文本和附近正文；
- equation：章节、LaTeX 和定义变量/解释公式的上下文；
- figure（文本模式）：caption、visionDescription、nearbyText；
- figure（VL 模式）：上述文本加图片 Data URI。

图表上下文继续复用现有 embedding-projection.ts 的结构优先规则，不按 PDF 二维坐标重新猜附近正文。Rerank 包不读取 SQLite，也不负责解析文件；图片读取和文本投影应由 PaperAgent 的 retrieval/domain seam 提供。

### 12.5 检索器集成

新增 RerankingPaperRetriever 装饰器，包裹任意 PaperRetriever：

~~~ts
class RerankingPaperRetriever implements PaperRetriever {
  constructor(
    private readonly base: PaperRetriever,
    private readonly reranker: PaperReranker,
  ) {}
}
~~~

这样可以覆盖两种基础模式：

~~~text
SqlitePaperRetriever
        ↓
RerankingPaperRetriever

HybridPaperRetriever
        ↓
RerankingPaperRetriever
~~~

每个搜索方法的处理步骤：

1. 让底层 retriever 取得候选集，而不是只取得最终 topN；
2. 对候选按 sourceId 去重；
3. RRF 模式先保留前 candidateLimit 条，默认 20，最大 50；
4. 从 SQLite hydrate 标题、章节、页码、excerpt 和当前 revision；
5. 构造 RerankDocument；
6. 根据是否含真实图片选择文本模型或 VL 模型；
7. 按返回的 index 映射回原候选 sourceId；
8. 返回用户请求的 limit 条；
9. 继续使用原有 evidence/citation 流程。

不能把 Rerank 分数与 SQLite BM25、ES cosine 或 RRF 分数直接相加。RRF 只负责候选融合，DashScope 分数只负责同一批次内的最终顺序。

### 12.6 配置与 UI

在 packages/tools/src/config.ts 增加：

~~~yaml
reranker:
  enabled: true
  credentialRef: DASHSCOPE_API_KEY
  model: auto                 # auto | qwen3-rerank | qwen3-vl-rerank
  endpoint: https://dashscope.aliyuncs.com
  candidateLimit: 20
  topN: 6
  timeoutMs: 30000
  includeFigureImages: false
  maxImageBytes: 5242880
  instruct: Given a research question, retrieve passages that directly answer it.
~~~

DashScope API Key 复用现有设置，不新增密钥。是否启用 Rerank 建议单独持久化为 paperagent_settings.rerankerEnabled，与 embedding 和 Elasticsearch 开关分离，从而支持：

- SQLite + Rerank；
- SQLite + ES + RRF；
- SQLite + ES + RRF + Rerank；
- 仅 SQLite。

设置 UI 复用 DashScope API Key 卡片，增加独立的 Rerank 开关。模型、候选数和 Top-N 属于 Host 配置，不暴露给浏览器；关闭时必须与当前 RRF 行为一致。只有 Host 配置启用 Rerank 时才显示该开关。

### 12.7 检索轨迹扩展

当前轨迹阶段为：

~~~text
sqlite → embedding → elasticsearch → fusion → final
~~~

增加：

~~~text
sqlite → embedding → elasticsearch → fusion → rerank → final
~~~

需要修改：

- packages/retrieval/src/index.ts；
- packages/contracts/src/paper-retrieval-trace.ts；
- packages/tools/src/retrieval-trace.ts；
- packages/ui/src/client/Retrieval.tsx。

Rerank 阶段记录：

~~~ts
{
  kind: 'rerank',
  status: 'completed',
  method: 'dashscope-rerank',
  durationMs: 720,
  candidates: [
    {
      sourceId: 'chunk-1',
      rank: 1,
      sqliteRank: 3,
      elasticRank: 1,
      fusionScore: 0.031,
      rerankScore: 0.934,
      excerpt: '...'
    }
  ]
}
~~~

当前实现继续使用 version 1，并在 decoder 中增加 rerank stage 和 rerankScore 字段；后续若改变事件结构再升级版本。这样现有历史事件仍可读取，新增字段均为可选且不写入敏感内容。

轨迹中禁止写入 API Key、Authorization、query embedding、图片 Base64、完整 Rerank prompt、完整请求/响应和未截断论文正文。

### 12.8 降级与错误策略

Rerank 是增强能力，不应让基础检索失败。关闭开关时直接跳过该阶段；以下运行时异常统一记录 `rerank:fallback` 并返回 RRF/SQLite 顺序：

- DashScope key 缺失；
- HTTP 401、429、5xx；
- 请求超时；
- 文本或图片超出限制；
- 响应 decoder 校验失败；
- 图片不可读或 MIME 不支持。

首版不提供 strict 模式。返回给 LLM 的结果必须明确仍是 fallback 结果，不能伪造“已完成精排”。

### 12.9 分阶段实施与验收

| 阶段 | 实施内容 | 验收标准 |
| --- | --- | --- |
| R1 | 新增 DashScope 文本 Rerank 包 | 已完成：qwen3-rerank 请求、响应、超时、HTTP 错误和边界校验有单元测试 |
| R2 | 接入 RerankingPaperRetriever | 已完成：SQLite-only 和 Hybrid 均可精排，sourceId 映射正确，失败自动回退 |
| R3 | 增加候选构造和文本模型路由 | 已完成：chunk/table/equation/文本化 figure 使用统一文本投影，不发送本地路径 |
| R4 | 增加 rerank 轨迹阶段 | 已完成：检索视图可查看 rerank 候选、RRF 分数、Rerank 分数和最终排名 |
| R5 | 增加 VL Rerank | 首版已提供 VL 适配器和受控图片读取 seam；需在真实账号下验收图片候选及配额 |
| R6 | 增加设置 UI 与回归测试 | 已完成：DashScope 卡片独立开关、Host 能力隐藏、关闭保持原行为、服务失败回退 |

完成标准是：一次检索可以在“检索”视图中完整看到 SQLite 召回、ES 召回、RRF 融合、DashScope 精排和最终引用；同时关闭 DashScope 或 Elasticsearch 后，SQLite 基础检索仍可用。
