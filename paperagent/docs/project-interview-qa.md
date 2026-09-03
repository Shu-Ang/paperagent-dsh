# PaperAgent-DSh 项目面试问答

> 本文按照“面试官先了解整体设计，再追问关键技术取舍”的方式编写。内容以当前 `deepseek-harness` 和 `paperagent-dsh` 的源代码、配置及 DSH 文档为准，重点回答架构、数据流和工程设计，不记录历史调试过程中的零散问题。

## 1. DSH 框架的核心思想是什么？Cordis 在其中扮演什么角色？

DSH（DeepSeek Harness）不是一个只负责调用大模型的 SDK，而是一个可组合的 Agent 运行时。它把一次智能体工作拆成几类可独立替换的能力：会话事件、Agent Loop、工具、模型、记忆、技能、工作区、轨迹和 Web UI。插件只需要声明自己提供的服务、工具或界面扩展，运行时就可以将这些能力组合到同一个 Agent 中。

核心思想可以概括为三点：

1. **事件是交互的事实来源**：用户消息、模型输出、工具调用和工具结果都记录为有序事件；对话和轨迹页面是这些事件的不同投影。
2. **能力通过服务组合**：业务模块不直接修改核心循环，而是注册服务、工具和扩展事件，由运行时负责调度。
3. **前后端通过受约束的协议通信**：工具参数、远程 API、事件和 UI 贡献都使用类型化契约，避免插件把任意运行时代码塞进客户端。

Cordis 是 DSH 使用的依赖注入和插件运行时。它提供 `Context`、服务定义、依赖注入、生命周期和效果管理。一个 Cordis 插件通常包含 `name`、`inject` 和 `apply(ctx, config)`：

```text
配置文件
   │
   ▼
Cordis 创建 Context ──► 按依赖加载服务 ──► 执行插件 apply()
                              │
                              ├─ tools / agent / session / webServer
                              └─ domain / UI / skill 等扩展
```

因此 PaperAgent 不需要复制 DSH 的 Agent Loop；它把论文领域能力接到 Cordis 服务和工具上，复用 DSH 的调度、会话、认证与 UI 插槽。

## 2. DSH 的会话、记忆和轨迹如何实现？

### Session：一次交互的事件日志

Session 表示一个连续的 Agent 交互上下文。它不是简单的“聊天消息数组”，而是一个追加式、带序号的事件流。事件包含 turn/step 生命周期、用户消息、助手消息片段、工具调用、工具结果、错误和插件扩展事件。消息列表是事件流的派生视图，因此流式输出、工具调用和恢复都能保持同一顺序。

```text
Session
  ├─ turn/start
  ├─ user/message
  ├─ step/start
  ├─ assistant/chunk ... assistant/message
  ├─ tool/call ── tool/result
  ├─ step/end
  └─ turn/end
```

事件日志可以持久化并重新播放，轨迹页正是通过它重建调用时间线。扩展事件必须在插件中声明并提供协议，否则旧/新运行时无法安全解释日志。

### 记忆：上下文构建，而不是只有一个 session

DSH 的短期记忆来自当前 Session 的事件和当前 turn 的派生上下文；Agent 每步会把系统提示、会话消息、工作区上下文和工具定义组合成模型输入。DSH 不会自动把所有 Session 变成一个通用的跨会话语义记忆库。跨 Session 的长期事实由具体应用负责持久化和检索，例如 PaperAgent 的 SQLite 论文库、Markdown 文件、向量索引和检索记录。

这一区分很重要：Session 负责“这次对话发生了什么”，领域数据库负责“应用长期保存了什么”。

### Trajectory：同一事件流的可视化投影

轨迹不是另建一套执行数据库，而是把 Session 的 step、tool call、result、timing 等事件组织成时间线，便于解释 Agent 做了什么。PaperAgent 通过 `paperagent/retrieval-trace` 和 `paperagent/citations` 等扩展事件补充 RAG 和引用信息，在插件提供的“检索”视图中展示查询、召回、融合和重排阶段。

## 3. DSH 的 Agent Loop 是如何工作的？是 ReAct 吗？

核心实现位于 DSH 的 `packages/core/agent-loop/src/agent.ts`，运行时对象是 `ReactLoopAgent`。一次 turn 可以包含多个 step：

```text
用户输入
  │
  ▼
组装 system prompt + 会话上下文 + 工具定义
  │
  ▼
调用模型（流式 assistant 输出）
  │
  ├─ 没有 tool call ──► 保存最终 assistant message ──► turn 结束
  │
  └─ 有 tool call
       ▼
     校验参数并调度工具
       ▼
     写入 tool result
       ▼
     进入下一个 step，再次调用模型
```

它具有 ReAct 的“模型决定动作—执行工具—观察结果—继续推理”控制结构，但并不要求模型输出可供正则解析的 `Thought/Action` 文本；工具调用使用模型原生结构化接口。循环还负责流式事件、取消、错误边界、最大步骤/令牌限制，以及对可并行工具进行受控调度。因此 PaperAgent 只注册工具和提示词，不能也不应该自行复制一套循环。

## 4. 如何定义 DSH 插件？PaperAgent-DSh 是怎样接入的？

一个 DSH 插件通常分为运行时入口和可选的客户端贡献。入口导出 Cordis 插件，在 `apply()` 中注册领域服务、工具、技能、远程 API 和事件；前端通过 DSH 的 client module、slot/view 和远程契约挂载 UI。

PaperAgent-DSh 的职责按包划分如下：

| 包 | 主要职责 |
| --- | --- |
| `domain` | SQLite schema、行模型、仓储、论文文件路径、解析修订和索引任务状态 |
| `parser-mineru` | 调用 MinerU 精准解析 API，下载归档并生成 Markdown、source-map、元素和引用 |
| `embedding-dashscope` | 调用 DashScope `qwen3-vl-embedding`，统一编码文本和图片 |
| `retriever-elasticsearch` | 将向量写入/查询 Elasticsearch，并把结果映射回论文事实 |
| `retrieval` | SQLite 词法召回、ES 召回、去重、RRF 融合和重排编排 |
| `reranker-dashscope` | 调用 `qwen3-rerank` 或 `qwen3-vl-rerank` 对候选重排 |
| `vision-deepseek` | 异步调用 `deepseek-v4-flash-vision-exp` 生成图片描述 |
| `tools` | Agent 工具、远程 BFF、索引 worker、Skill 注册、检索轨迹和引用录制 |
| `ui` | 论文库、详情/编辑、PDF 预览、检索视图、引用渲染和设置页 |
| `contracts` | 工具/远程 API/扩展事件的类型化协议 |
| `bundle` | 对外暴露插件的打包入口 |

典型加载关系为：

```text
DSH web profile
      │
      ▼
PaperAgent bundle ──► Cordis plugin
      │                    │
      │                    ├─ domain services + SQLite
      │                    ├─ paper tools + remote APIs
      │                    ├─ skills (SKILL.md + registrar)
      │                    ├─ retrieval/index workers
      │                    └─ UI client contributions
      ▼
仍由 DSH 负责 session、agent loop、模型、权限和宿主页面
```

这种方式属于“插件提供领域能力，宿主提供运行时能力”，不迁移或复制 DSH 核心代码。

## 5. 论文从 PDF 到可检索索引的完整流程是什么？

当前路线只使用 MinerU 精准解析 API，不保留本地解析器作为回退：

1. 用户上传 PDF，PaperAgent 为论文创建唯一 ID，并把原始文件放入当前工作区的本地目录。
2. 服务向 MinerU `/api/v4/file-urls/batch` 创建上传任务，向签名 URL 上传文件，再轮询 `/api/v4/extract-results/batch/<batchId>`。
3. 下载结果 ZIP，读取 `full.md` 和 `content_list_v2.json`（兼容旧版 `content_list.json`）。
4. 解析 Markdown 标题层级、自然段、结构化元素、页码和引用信息，生成 `paper.md`、`source-map.json`、图片目录及 SQLite 记录。
5. 以事务方式提交一个新的 `revision`：正文、section、chunk、元素、figure、reference 都指向该修订；解析失败不会把半成品标记为 ready。
6. 解析完成后异步创建 embedding/index job。SQLite 事实数据先可用，ES 和 embedding 是可选的派生索引。

```text
PDF ─► MinerU task ─► ZIP
                 ├─ full.md ─► section/chunk
                 ├─ content_list ─► figure/table/equation/code/list
                 └─ page/image metadata
                         │
                         ▼
                  atomic revision commit
                         │
                         ├─ SQLite FTS
                         └─ async embedding ─► Elasticsearch kNN
```

目录采用修订隔离：`papers/<paperId>/original.pdf` 保存原始 PDF，解析产物放在 `papers/<paperId>/revisions/<revisionId>/` 下。当前生效内容由论文的 ready revision 指向，历史修订可用于审计和重新索引。

## 6. Section、父子 Chunk 和结构化元素如何划分？

Section 根据 Markdown 中的数字、罗马数字或字母编号标题推断层级，因此既能识别 `3 Method`，也能识别 `3.1 Method A`。一级 section 是导航和聚合边界，二级 section 仍然保留自己的路径，而不是把整章当成一个巨大文本块。

正文检索单位是 `paper_chunks`。切片优先保护自然段：先按段落分组，再在超过软阈值时按句子边界切分；只有单句极长时才进行硬切分。相邻的一两句短段会通过栈式合并策略合并到相邻 chunk，避免产生大量没有语义密度的碎片。因此目标是“尽量完整的段落 + 有上限的长度”，而非固定字符数截断。

可以把它理解为父子关系：section 是父级语义范围，chunk 是 section 内的子级检索单元。

```text
3 Method                  (section / parent)
  ├─ chunk-31              (paragraph group)
  ├─ 3.1 Method A          (nested section)
  │    ├─ chunk-311
  │    └─ chunk-312
  └─ 3.2 Method B
       └─ chunk-321
```

`paper_elements` 只保存 `figure`、`table`、`equation`、`code`、`list`，不再把普通 text 复制成 element，也不保存 bbox。元素记录类型、标题/说明、页码、所属 section/chunk 和资源路径，正文仍由 `paper_chunks` 负责。

## 7. 图片、表格、公式和参考文献怎样特殊处理？

### 图片与表格

图片保存在修订目录的 `images/`，`paper_figures` 保存 caption、页码、路径、关联 chunk 和描述状态。上下文不是简单取图片前后固定几行，而是按优先级组合：解析器提供的图号/表号关联、正文中明确提及该元素的 chunk、同一 Markdown 逻辑块的邻近段落，最后才使用同页文本作为兜底。这样可以降低论文排版顺序与语义顺序不一致造成的错配。

图片描述由异步任务调用 DeepSeek 视觉模型生成，描述结果作为可检索文本和 UI 预览辅助信息；原图路径和页码始终保留，描述失败不会破坏正文索引。

### 公式、代码和列表

MinerU 输出的公式、代码、列表被识别为结构化 element，保留 Markdown/LaTeX 内容和页码，必要时建立独立 element embedding。它们可以被专门的 `search_paper_elements` 检索，再通过关联 chunk 回到正文上下文。

### 参考文献

解析器优先识别 `References`、`Bibliography`、`参考文献` 等标题；若原文没有明确标题，则根据连续的编号、年份、DOI 等引用条目识别参考文献区段。引用条目独立写入 `paper_references`，包含序号、原文、作者/年份/标题等可解析字段和页码；这使得“查看某篇论文的参考文献”不必从大段正文中猜测。

## 8. PaperAgent 的检索与召回全过程是什么？

Agent 通常先调用 `search_paper_library` 进行候选召回，再根据证据 ID、section 和页码调用 `get_paper_outline`、`read_paper_section`、`search_paper_elements` 或引用工具读取详情。检索层本身不让模型直接拼文件路径，而是返回带有论文、修订、section、chunk、页码和 evidence ID 的结构化证据。

```text
用户问题
  │
  ▼
生成查询（原问题/改写词/过滤条件）
  │
  ├─ SQLite FTS 召回正文 chunk
  ├─ 可选 embedding + ES kNN 召回 chunk/element
  └─ 结构化过滤：workspace、library、paper、revision
          │
          ▼
       去重与 RRF 融合
          │
          ▼
       DashScope rerank
          │
          ▼
返回证据列表（evidence ID + 内容 + 来源坐标）
          │
          ▼
LLM 读取详情、选择证据、生成答案和引用标记
```

检索过程会记录 query、各路召回候选、融合分数、重排分数和最终证据，形成 `paperagent/retrieval-trace`，既用于“检索”页面，也用于定位召回质量问题。

## 9. SQLite 全文索引的原理是什么？

SQLite 使用 FTS5 虚拟表为正文 chunk、元素和图片描述建立倒排索引。写入论文 chunk 时，同时写入 `paper_chunks_fts` 的搜索文本；查询时通过 `MATCH` 找到包含词项的记录，并用 BM25 类排名计算词法相关性。中文场景会对文本做受控的 CJK 双字片段增强，减少没有空格分词时的召回损失。

倒排索引可以抽象为：

```text
词项 ─► [(chunkId, term frequency, positions), ...]
```

查询多个词时，FTS 合并各词项的 posting list，再根据词频、逆文档频率和字段长度得到排名。PaperAgent 用关系表保存真实内容和坐标，FTS 只负责快速定位候选；如果运行环境缺少 FTS5，则退化为有上限的 LIKE/词法评分，保证本地应用仍可工作。

SQLite FTS 适合精确术语、作者名、模型名、数据集名、公式变量和章节号等检索，但它无法很好理解同义改写和跨模态相似性。

## 10. Elasticsearch 是什么？本项目使用了哪些功能？kNN 如何工作？

Elasticsearch 是基于 Lucene 的分布式搜索与分析引擎。本项目把它作为**可选的派生向量索引**，SQLite 仍是论文事实、权限和任务状态的主存储。ES 文档保存 paper/chunk/element 身份、workspace/library、section、页码、revision 和 embedding，检索结果再回 SQLite 进行权限过滤和内容补全。

适配器使用的主要 REST 操作包括：

```text
GET  /
HEAD /<index>
PUT  /<index>
POST /_bulk
POST /_delete_by_query
POST /<index>/_search
```

索引 mapping 中的 embedding 是 `dense_vector`，维度由 DashScope 模型配置决定，空间使用 cosine 相似度。向量检索流程是：

1. 用同一个 embedding 模型把 query 和文档编码为向量 `q`、`d`。
2. 计算余弦相似度：

   \[
   \operatorname{cos}(q,d)=\frac{q\cdot d}{\|q\|\,\|d\|}
   \]

3. 在 dense vector 索引中取相似度最高的候选。
4. ES 通常使用 HNSW 等近似最近邻结构缩小搜索范围；`k` 控制返回数量，`num_candidates` 控制候选池大小，在速度和召回率之间取舍。

PaperAgent 不实现 HNSW 算法本身，而是通过 ES 的 kNN 查询使用它；应用层负责模型一致性、revision 过滤、去重和 SQLite hydration。

## 11. 为什么要混合全文检索和向量检索？

两种检索解决的问题不同：

| 方式 | 擅长场景 | 局限 |
| --- | --- | --- |
| SQLite FTS | 精确术语、编号、作者、缩写、公式符号 | 同义改写、跨语言表达和隐含语义较弱 |
| ES 向量 | 语义相似、自然语言提问、跨语言和图片/文本相似 | 对罕见专名、精确编号和模型版本可能不稳定 |

只用其中一种会在另一类问题上漏召回，所以先并行取候选，再用 Reciprocal Rank Fusion（RRF）融合：

\[
   score(d)=\sum_{m\in\{fts,knn\}}\frac{w_m}{k_0+rank_m(d)}
\]

其中 `rank_m(d)` 是文档在某一路的名次，`k_0` 通常取 60，`w_m` 可按配置调整。RRF 不要求两路分数处于同一量纲，适合 SQLite 的 BM25 与 ES cosine 分数混合。融合后再交给 reranker，最后只返回有限且带来源坐标的证据。

## 12. Reranker 的原理是什么？项目使用什么模型？

Embedding/FTS 负责高召回，通常会产生几十个候选；reranker 把“查询 + 候选内容”作为一个整体重新判断相关性，输出更精细的 pairwise/listwise 相关分数，然后截取前若干条。它不是生成答案的 LLM，也不会改变证据的 paper、section 或页码。

本项目使用 DashScope 的 `qwen3-rerank` 处理纯文本候选；当候选包含图片或视觉元素时，切换到 `qwen3-vl-rerank`，将文本查询与图片/表格内容共同评分。没有视觉候选时不必调用 VL 模型；模型不可用或调用失败时保留 RRF 顺序，保证检索链路可降级。

完整排序关系为：

```text
FTS rank ─┐
          ├─ dedupe + RRF ─► text/VL rerank ─► final evidence
ES rank ──┘
```

## 13. 索引过程和 RAG 过程如何可视化？

解析完成后，`PaperEmbeddingJobs` 在 SQLite 中记录 `queued/processing/ready/failed`、总任务数、完成数和错误信息。worker 在后台消费任务，因此 UI 可以在论文列表的“索引状态”列显示进度，而不会阻塞 PDF 解析或对话。

RAG 过程由 `PaperRetrievalTraceCollector` 按阶段记录：query、SQLite 召回、embedding/ES 召回、融合、rerank 和最终证据。它写入 DSH Session 的 `paperagent/retrieval-trace` 扩展事件；插件 UI 在对话/轨迹区域旁提供“检索”标签，左侧是按时间排序的 query，右侧查看各阶段候选和分数。这样展示的是一次检索的完整路径，而不是只显示一个工具结果。

## 14. 引用如何从检索结果变成可点击的行间引用？

引用不是让 LLM 自由填写页码，而是由检索证据驱动：

1. 工具返回唯一 `evidenceId`，并携带 paper、revision、chunk/element、section 和 PDF 页码。
2. LLM 阅读检索详情，只在答案中选择实际使用的证据，输出受约定的 `paperagent-cite:<evidenceId>` 标记。
3. PaperAgent 录制器校验标记是否属于本轮已返回证据，并写入 `paperagent/citations` 事件。
4. UI 的 Markdown/消息渲染器把标记映射为连续编号 `[1]`、`[2]`，隐藏内部 ID。
5. 用户点击编号时，前端根据证据中的论文 ID、修订 ID 和 `pdfPageStart` 请求受保护的 PDF 访问地址，打开连续 PDF 预览并定位到目标页。

```text
检索证据 ─► evidenceId ─► LLM 选择 ─► citation event
                                      │
                                      ▼
                         [1] / [2] 行间渲染
                                      │ click
                                      ▼
                         PDF 预览 + 页码定位
```

这种设计把“引用内容”和“引用坐标”绑定在检索阶段，避免模型手写不存在的页码，也允许后续替换 UI 而不改变 Session 历史。

## 15. Skill 在 PaperAgent 中有什么作用？如何与工具配合？

PaperAgent 当前提供 `paper-import`、`paper-research` 和 `paper-writing` 三类 Skill。每个 Skill 由同目录的中文 `SKILL.md` 保存较长的工作流说明，再由 `*-skill.ts` 在运行时读取并调用 `ctx.skills.register` 注册。

Skill 是“如何组织任务”的策略层，不直接实现文件下载、解析或检索：

- `paper-import` 规定从 arXiv/普通 PDF URL 获取资源并导入论文库的标准步骤。
- `paper-research` 规定先列出论文/大纲，再检索正文、元素和引用，最后用 evidence ID 作答。
- `paper-writing` 规定如何在 LaTeX 中写作、润色，并把选中的 BibTeX 和 `\\cite{}` 写入指定目录。

实际执行仍由 DSH Agent Loop 调用 PaperAgent tools 完成。这样既能让模型遵循稳定流程，也能把安全边界、路径校验和业务逻辑留在 TypeScript 服务中。

## 16. 这个架构如何保证本地化、安全和可扩展？

项目使用 TypeScript + SQLite + 本地文件，当前不依赖 PostgreSQL。MinerU、DashScope embedding/reranker、DeepSeek vision 和 Elasticsearch 都是可选配置；没有 ES 时仍可使用 SQLite FTS，没有视觉描述时仍保留原图和正文索引。

安全边界主要在服务端：

1. 文件路径从受控 workspace、paper ID 和 revision ID 派生，不接受任意绝对路径。
2. 远程工具先校验 workspace/session 归属，再访问 SQLite 和文件。
3. ES 只保存可重建的派生向量，不作为权限事实源。
4. MinerU/模型调用失败会记录任务错误并保持可重试状态，不把失败结果标记为 ready。
5. 事件和远程接口使用 contracts 类型约束，客户端不直接导入其他插件的运行时值。

扩展新检索器、embedding 模型或数据源时，只需实现相应接口并接入 `retrieval` 编排层；扩展新的论文元素或 UI 页面时，新增领域记录、工具和 client contribution，不需要修改 DSH 核心循环。

## 17. 如果继续演进，你会优先改进什么？

从工程和效果两个维度看，优先级是：

1. **检索评测**：建立带答案证据的离线数据集，评估 FTS、向量、RRF 和 rerank 的 Recall@k、MRR、nDCG。
2. **可观测性**：为解析、embedding、ES bulk、rerank 增加耗时、重试和失败原因，关联到同一 retrieval trace。
3. **增量索引**：按 revision hash 和内容 hash 跳过未变化 chunk，减少重复 embedding。
4. **结构化引用**：增强 DOI、作者、年份和 BibTeX 字段解析，并与引用证据统一。
5. **多模态检索评测**：对图片 caption、表格内容和正文上下文分别测试，确认 VL embedding/rerank 的收益。

这些改进都建立在当前“SQLite 是事实源、ES 是可选派生索引、DSH 负责运行时、PaperAgent 负责领域能力”的边界之上。

---

## 关键代码和文档索引

- DSH Agent Loop：`deepseek-harness/packages/core/agent-loop/src/agent.ts`
- DSH Session/Workflow/Skill 文档：`deepseek-harness/docs/subsystems/`
- PaperAgent 领域模型与 SQLite：`paperagent-dsh/packages/domain/`
- MinerU 解析：`paperagent-dsh/packages/parser-mineru/`
- 检索编排：`paperagent-dsh/packages/retrieval/`
- Elasticsearch 适配器：`paperagent-dsh/packages/retriever-elasticsearch/`
- 工具、Skill、worker 与远程 API：`paperagent-dsh/packages/tools/`
- UI、引用和 PDF 预览：`paperagent-dsh/packages/ui/`
- 协议与扩展事件：`paperagent-dsh/packages/contracts/`
