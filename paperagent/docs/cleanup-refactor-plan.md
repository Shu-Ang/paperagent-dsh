# PaperAgent 代码清理与模块拆分计划

> 本文是 PaperAgent 插件的工程治理计划，配合 detailed-implementation-plan.md 使用。
> 当前只处理 `paperagent-dsh` 自身的代码可维护性、模块边界和测试质量，不修改 deepseek-harness。

## 当前执行状态（2026-08-31）

- C0 已完成：基线检查、公开契约盘点和回归样本确认完成。
- C1 已完成：生产死代码、旧 Remote 下载实现、无用导入和测试未使用变量已清理；严格 noUnused 已通过。
- C2 已完成首轮拆分：Domain 已按 schema、normalizer、mapper、repository 和索引职责组织，`PaperAgentStore` 保留为兼容门面；剩余细粒度拆分列入 C6 后续维护。
- C3 已完成首轮拆分：Parser、工具注册和运行时依赖已按 archive/content-list/import/library/elements/evidence 等职责拆分；Remote 契约保持兼容。
- C4 已完成：UI 已按单层业务模块收敛为 `Library.tsx`、`Pdf.tsx`、`Citations.tsx`、`Views.tsx`、`SidebarAction.tsx` 和 `MineruSettings.tsx`；论文库、PDF 预览和引用逻辑不再分散到页面专属 hooks、表格、对话框和 viewer 碎片文件。
- C5 已完成（历史记录）：此前为插件接入验证过的 DSH 通用扩展点已记录在附录；本阶段不再修改或测试 deepseek-harness。
- C6 已完成基线门禁：只执行 PaperAgent 的定向检查、构建、单元测试和必要的插件 E2E；Elasticsearch、Embedding 与 DashScope Rerank 已转入主计划实施，不在本清理文档中展开。

验证备注：PaperAgent 的 typecheck、严格 noUnused、核心单元测试、构建和必要的插件 E2E 均通过。DSH 全量 vitest 不属于本阶段门禁，不再自动执行。

## 1. 背景与目标

当前 PaperAgent 已经能够完成论文库、PDF/MinerU 解析、BibTeX、元素索引、检索、Agent 工具、引用跳转和 PDF 预览等闭环，但实现中存在几个长期风险：

1. 领域层、解析层、工具层和 UI 层存在超大文件，多个职责通过隐式状态和重复代码耦合在一起。
2. 部分历史迁移代码、注释掉的旧实现、未使用导入和兼容函数仍然留在生产目录中，增加阅读成本和误修改风险。
3. DSH 为支持 PaperAgent 增加过若干宿主改动，其中一部分是合理的通用扩展点，另一部分可以由插件自行完成，继续保留会扩大 DSH 核心维护面。
4. 当前尚缺少统一的 noUnused、架构边界和插件装载/卸载回归门禁，重构容易出现“编译通过但运行时协议被破坏”的情况。

本计划的目标是：

- 在不改变现有用户操作和公开接口的前提下，拆分大文件、删除死代码、减少重复逻辑。
- 将 DSH 中确实具有通用价值的改动整理成可复用的宿主扩展能力。
- 把 PaperAgent 的业务逻辑严格留在插件内，不在 DSH 核心中出现论文库、MinerU、BibTeX 或 PaperAgent 命名。
- 为后续 Elasticsearch、多模态向量检索等扩展建立清晰的端口/适配器边界。

## 2. 范围与非目标

### 2.1 本次范围

- `paperagent-dsh/packages` 下的 domain、parser-mineru、tools、ui、远程 API 和 skill 代码。
- PaperAgent 自身的测试、构建、类型检查、插件加载和必要的浏览器 E2E 门禁。
- 生成物、临时文件、依赖目录和测试夹具的仓库卫生。

### 2.2 本次不做

- 不迁移旧 PostgreSQL 数据，也不新增迁移脚本。
- Elasticsearch、Embedding 与 DashScope Rerank 不属于本清理文档的实现范围，具体状态以 detailed-implementation-plan.md 为准。
- 不修改 `deepseek-harness` 源码、测试、生成物或依赖；DSH 仅作为外部运行时依赖。
- 不执行 deepseek-harness 全量测试；仅在 PaperAgent 需要时运行最小插件加载/E2E 验证。
- 不重写业务行为，不改变现有工具名、Remote API 名、SQLite 数据格式和文件存储路径。
- 不复制 DSH 核心代码到 PaperAgent；只通过公开的扩展点复用 DSH 能力。
- 不把生成的 lib、子包 node_modules、source map 当作源代码重构对象。它们由构建工具生成或由包管理器管理。

## 3. 重构原则

1. **行为先于结构**：每个拆分前先固化现有行为测试；拆分后公开 API 和输出契约保持不变。
2. **单向依赖**：domain 只依赖存储抽象和纯类型；parser 依赖解析端口；tools 组合 domain/parser；UI 只调用 Remote API，不直接访问 SQLite 或宿主路径。
3. **端口/适配器**：网络、MinerU、文件系统、SQLite、DSH 会话服务都通过端口注入；业务服务不直接创建全局客户端。
4. **兼容门面**：大文件拆分后保留原入口文件作为薄门面，先保证旧 import 路径和包导出不变，再逐步迁移调用方。
5. **通用宿主**：任何进入 DSH 的代码都必须能被其他插件复用；不得出现 paperagent、paper、MinerU、BibTeX 等业务名称。
6. **小提交可回滚**：每个阶段一个主题、一个可运行状态；先加新模块和兼容门面，再删除旧实现。
7. **先清理再扩展**：C6 门禁通过后，扩展功能必须沿已建立的端口/适配器边界实现。

## 4. 当前代码盘点与目标结构

以下行数为不含生成目录的生产代码粗略规模，实际拆分以职责为准，不以机械切行数为准。

| 当前文件 | 主要问题 | 目标模块 |
| --- | --- | --- |
| packages/domain/src/domain.ts（约 1910 行） | schema、迁移、CRUD、FTS、元素、解析任务全部混杂 | schema.ts、migrations.ts、db.ts、repositories/library-repository.ts、paper-repository.ts、search-repository.ts、element-repository.ts、parse-job-repository.ts、row-mappers.ts、store.ts 门面 |
| packages/parser-mineru/src/parser.ts（约 900 行） | HTTP、轮询、ZIP、Markdown、chunk、元素、图片资源处理混杂 | mineru-client.ts、archive-reader.ts、content-normalizer.ts、artifact-builder.ts、element-indexer.ts、figure-assets.ts、parser.ts 门面 |
| packages/tools/src/plugin.ts（约 1030 行） | 18 个工具的 schema、执行、错误处理、提示词和引用逻辑混杂 | tool-context.ts、tool-schemas.ts、library-tools.ts、paper-tools.ts、search-tools.ts、import-tools.ts、citation-tools.ts、plugin.ts 组合器 |
| packages/tools/src/remote.ts（约 500 行） | Remote API、文件流、导入、论文、图像和 PDF 访问混杂 | remote-context.ts、library-remote.ts、paper-remote.ts、import-remote.ts、pdf-remote.ts、figure-remote.ts、remote.ts 门面 |
| packages/ui/src/client/PaperAgentManagementView.tsx、PaperAgentReader.tsx 及多个碎片文件 | 同一论文库工作流和 PDF 阅读工作流被拆成管理视图、表格、对话框、hooks、viewer 多层文件，状态追踪成本高 | `client` 根目录下的 `Library.tsx`、`Pdf.tsx`、`Citations.tsx`；仅保留同级的通用契约文件 |
| packages/tools/src/remote.ts 中旧下载实现 | 大段注释代码和旧 ArXiv 元数据逻辑仍可见 | 删除旧实现；保留当前 adapter/downloader 端口 |
| 多个 adapter/test 文件 | 未使用类型导入、变量和过时兼容类型 | 通过 noUnused 门禁逐项清除 |

目标目录示意：

~~~text
packages/
  domain/src/
    db.ts
    schema.ts
    migrations.ts
    row-mappers.ts
    repositories/
    store.ts
  parser-mineru/src/
    mineru-client.ts
    archive-reader.ts
    content-normalizer.ts
    artifact-builder.ts
    element-indexer.ts
    figure-assets.ts
    parser.ts
  tools/src/
    tool-context.ts
    tool-schemas.ts
    library-tools.ts
    paper-tools.ts
    search-tools.ts
    import-tools.ts
    citation-tools.ts
    plugin.ts
    remote-context.ts
    *-remote.ts
  ui/src/client/
    Views.tsx
    Library.tsx
    Library.module.css
    Pdf.tsx
    Pdf.module.css
    Citations.tsx
    SidebarAction.tsx
    MineruSettings.tsx
    api-types.ts
    remote.ts
    navigation.ts
    ui-utils.ts
~~~

## 5. Domain 拆分方案

### 5.1 模块职责

- schema.ts：表名、字段、索引和 FTS 定义，只包含 SQL 常量和版本化 schema 描述。
- migrations.ts：按版本执行迁移；不包含论文业务判断。
- db.ts：创建 SQLite 连接、启用 WAL/foreign_keys、事务和 busy timeout。
- row-mappers.ts：数据库行到领域类型的纯函数，统一日期、JSON 和可空字段处理。
- repositories/library-repository.ts：论文库 CRUD、重命名、删除、跨库移动。
- repositories/paper-repository.ts：论文元数据、PDF/BibTeX 关联、删除和更新。
- repositories/search-repository.ts：FTS 查询、关键词兜底查询、排序和分页。
- repositories/element-repository.ts：figure/table/equation 元素、caption、chunk_id、source-map 关联。
- repositories/parse-job-repository.ts：解析任务状态和错误信息。
- store.ts：保持现有 PaperAgentStore 公开方法，内部组合各 repository；不得再新增 SQL 业务逻辑。

### 5.2 一致性与事务

1. 所有跨表写操作通过 db.transaction() 或统一 withTransaction() 执行。
2. 文件写入采用 staging + 原子 rename；数据库提交成功后再替换旧文件，失败时清理 staging。
3. replacePaperPdf 必须保证“新文件、论文记录、解析任务”不会出现半更新状态。
4. paper 删除、library 删除和移动操作必须同步更新 FTS、元素表和 parse job 引用。
5. 统一 workspace/session 校验，repository 不接受任意路径；路径解析集中在 file-storage adapter。
6. SQLite 错误转换为稳定的领域错误码，Remote 和 Agent 层不得自行解析底层错误字符串。

### 5.3 兼容策略

- 保留 domain.ts 导出的类型和 PaperAgentStore 名称，先改为 re-export/薄门面。
- 保留旧构造函数参数和默认配置；新 repository 通过内部 factory 创建。
- 先增加 repository 单测，再迁移调用；确认覆盖后才删除 domain.ts 中的旧实现。

## 6. MinerU Parser 拆分方案

### 6.1 模块职责

- mineru-client.ts：创建上传任务、轮询任务、下载结果；只处理 HTTP 状态、超时、重试和响应体。
- archive-reader.ts：读取 ZIP，校验路径、大小、CRC 和必需文件；不理解论文业务。
- content-normalizer.ts：兼容 content_list_v2.json 和旧版 content_list.json，规范文本、公式、表格、图片记录。
- artifact-builder.ts：由规范化记录生成 Markdown、text chunks、source-map 和元素记录。
- element-indexer.ts：写入 figure/table/equation 的 caption、page、chunk_id、asset_path 和元数据。
- figure-assets.ts：从归档安全提取图片，生成描述任务所需的本地资产。
- parser.ts：保留当前 parser API，负责按顺序组合上述模块。

### 6.2 必须删除的遗留内容

- 未使用的默认轮询/超时常量。
- 已无调用方的 readPreviousArtifacts()、restorePreviousArtifacts()。
- 重复的旧版内容列表分支；保留统一兼容适配器。
- 解析失败时泄漏临时目录和文件句柄的旧路径。

### 6.3 解析契约

解析结果必须继续包含：

- 论文级 Markdown 和原始 PDF 路径；
- 文本 chunk（稳定 chunk_id、页码和章节信息）；
- figure/table/equation 元素（类型、caption、页码、chunk_id、asset_path）；
- source-map（chunk/element 到 Markdown 行和 PDF 页面的映射）；
- MinerU 原始响应和失败阶段的可诊断错误。

## 7. Agent Tools 与 Remote 拆分方案

### 7.1 工具层

- tool-context.ts：统一注入 store、parser、import service、workspace resolver、引用注册器。
- tool-schemas.ts：集中定义参数 schema 和输出类型；schema 与执行函数分离。
- library-tools.ts：列出、创建、重命名、删除和移动论文库。
- paper-tools.ts：论文详情、BibTeX、PDF、元素和解析状态。
- search-tools.ts：正文/元素检索和检索证据格式化。
- import-tools.ts：ArXiv/DOI/普通 PDF URL 解析、候选确认和导入。
- citation-tools.ts：引用证据注册、引用 token 和 PDF 页跳转信息。
- plugin.ts：只做工具注册、skill 注册和生命周期绑定。

### 7.2 统一执行约束

1. 每个工具先调用 requireExecutionWorkspace()，不得从模型参数接受任意绝对路径。
2. 网络导入只能经 paper-import-service 和 binary-downloader，domain 不发网络请求。
3. 候选导入必须携带稳定 candidate_id；多候选时禁止默认取第一项。
4. 工具错误统一转换为用户可理解的阶段、来源、重试建议；不得吞掉原始 cause。
5. 工具名和返回字段保持兼容；新增字段只允许向后兼容地追加。

### 7.3 Remote 拆分

Remote handler 只负责参数校验、调用应用服务和序列化结果：

- 不在 Remote 中执行 SQL；
- 不在 Remote 中读取 DSH 会话内部状态；
- 上传和下载使用统一的流/临时文件 helper；
- PDF access、figure access 使用同一权限和路径校验；
- 删除注释掉的旧下载器、旧 ArXiv metadata 类型和无调用方函数。

## 8. UI 业务模块合并与异步生命周期

> 本节取代早期“一个表格/一个对话框/一个 hook 一个文件”的拆分方案。`client` 保持单层目录，第一层边界按完整业务模块划分；只有文件确实过大、可复用或有独立生命周期时才拆分。不得为了降低单文件行数而拆出几十行的碎片文件，也不新增 `pages`、`shared`、`components`、`hooks` 等目录或名称前缀。

### 8.1 当前问题与合并原则

当前 `packages/ui/src/client` 已出现以下过度拆分：`PaperAgentPaperTable.tsx`、`PaperAgentPaperDetails.tsx`、`PaperAgentConfirmDialogs.tsx`、`PaperAgentPaperDialogs.tsx`、`PaperMetadataFields.tsx`、`usePaperCatalog.ts`、`usePaperSelection.ts`、`usePaperExport.ts` 共同服务同一个论文库业务模块；PDF 预览又被拆成 `PaperAgentReader.tsx`、`PaperPdfDrawer.tsx`、`PaperPdfFullscreen.tsx`、`PdfDocumentViewer.tsx` 和多个很小的样式文件。这样会导致状态、请求、弹窗和布局分散，修改一个用户操作需要跨多个文件追踪。

合并时遵循以下规则：

1. 先按业务模块分类，再按模块内部职责组织代码；模块状态、数据请求、用户操作和 JSX 默认放在同一个文件。
2. 新建、编辑、详情、删除确认属于同一个论文库工作流，默认合并到论文库模块；只有出现真正跨模块复用时才单独保留。
3. PDF 连续阅读、缩放、全屏、目标页定位、访问地址和加载错误属于同一个阅读模块，默认合并到 PDF 模块。
4. 引用 token 解析、行间引用渲染、点击跳转和引用样式属于同一个引用渲染模块；不再拆出单独的 definition/style 碎片。
5. Remote 类型、导航服务、API 客户端、纯工具可以独立存在，但都直接置于 `client` 根目录，不能把模块状态抽成只有几十行的 hook。
6. 单个文件建议保持在约 150--800 行；低于约 80--100 行的模块专属文件原则上合并回所属模块。超过约 800--1000 行时，按“完整子工作流”拆分，而不是按函数拆分。

### 8.2 目标文件结构与职责

目标结构如下（名称可按现有导出兼容调整）：

~~~text
packages/ui/src/client/
  Views.tsx                           # DSH 宿主适配和模块切换，保持很薄
  Library.tsx                         # 论文库完整工作流
  Library.module.css                  # 论文库样式
  Pdf.tsx                             # PDF 连续阅读完整工作流
  Pdf.module.css                      # 阅读器、全屏和工具栏样式
  Citations.tsx                       # 行间引用 token、解析、渲染和点击跳转
  SidebarAction.tsx                   # 侧栏入口宿主适配
  MineruSettings.tsx                  # DSH 设置中的 MinerU 配置
  api-types.ts                        # Remote/API 契约类型
  remote.ts                           # 客户端 API 调用
  navigation.ts                       # 模块切换与阅读导航
  ui-utils.ts                         # 纯 UI 工具
~~~

`Library.tsx` 内部按固定顺序组织：类型和本地状态 → 论文库/论文加载 → 解析任务轮询 → 新建/编辑/详情/删除/移动/导出操作 → 列表与操作列 → 对话框 JSX。论文表格、解析状态单元格、元数据字段、BibTeX 上传和新建/编辑对话框先作为同文件中的局部组件或函数维护；只有确认它们被其他模块复用，或该文件超过规模阈值，才拆成最多 1--2 个同级业务文件。

`Pdf.tsx` 内部统一维护 PDF access、连续多页渲染、滚轮滚动、缩放、全屏、目标页初始定位、加载错误和返回导航。`PaperPdfDrawer`、`PaperPdfFullscreen`、`PdfDocumentViewer` 不再作为互相依赖的顶层文件；如 PDF 渲染器因库适配需要独立，最多保留一个同级 `PdfCanvas.tsx` 或 `PdfDocument.tsx`，且不携带 PaperAgent 业务状态。

`Citations.tsx` 同时包含 citation token 定义、Markdown inline mention 解析、编号映射、可点击链接和样式。引用论文卡片保持删除状态，不恢复为独立 UI。

### 8.3 本轮合并/迁移清单

1. 将 `PaperAgentManagementView.tsx` 作为迁移起点，收敛为同级 `Library.tsx`；保持现有路由、主视图注册和 Remote API 名称不变。
2. 把 `usePaperCatalog.ts`、`usePaperSelection.ts`、`usePaperExport.ts` 的逻辑合并回 `Library.tsx`，改为模块内的加载函数、选择状态和导出处理；删除只服务该模块的三个 hooks。
3. 把 `PaperAgentPaperTable.tsx`、`PaperAgentPaperDetails.tsx`、`PaperAgentConfirmDialogs.tsx`、`PaperAgentPaperDialogs.tsx`、`PaperMetadataFields.tsx` 合并到 `Library.tsx`；新建和编辑继续通过同一表单模式复用，不复制字段 JSX。
4. 将 `useParseJobs.ts` 合并到 `Library.tsx`，保留 AbortController、generation 防抖、workspace 切换清理和错误状态；只有后续出现第二个使用者时才重新抽成同级通用模块。
5. 将 `PaperAgentReader.tsx`、`PaperPdfDrawer.tsx`、`PaperPdfFullscreen.tsx`、`PdfDocumentViewer.tsx`、`pdf-preview.ts` 及其专属 CSS 合并为同级 `Pdf.tsx` 与 `Pdf.module.css`；保留 PDF 渲染库所需的最小适配层。
6. 将 `PaperCitationDefinition.ts` 与引用渲染相关 JSX/样式合并为同级 `Citations.tsx`；所有调用方只依赖稳定的渲染入口。
7. `Views.tsx` 只保留 DSH 宿主集成、模块切换和模块装配；不得在其中堆积论文请求、弹窗状态或 PDF 逻辑。
8. 保留 `api-types.ts`、`remote.ts`、`navigation.ts`、`ui-utils.ts` 等同级基础设施；它们不因模块合并而内联，也不再新增模块专属的小型 wrapper。
9. 迁移完成后删除旧文件和失效 CSS，使用 `rg` 检查无残留 import、重复样式和重复表单字段；不得手工修改 `lib` 或 `node_modules`。

### 8.4 模块级异步与样式约束

1. 论文库模块统一管理加载、上传、解析轮询、删除、移动和导出状态；每个请求都有取消或 generation 校验，禁止组件卸载后 setState。
2. PDF 模块统一管理 access URL、目标页、滚动容器、缩放比例和全屏状态；进入目标页时等待文档布局完成后再定位，返回论文库时清理 object URL 和监听器。
3. 模块不直接拼接 host 文件路径，不重复实现错误 toast；所有 API 错误通过统一 Remote 错误适配处理。
4. 继续使用 DSH 的按钮、Dialog、表格、Popover、Tooltip 和图标组件；删除手写灰色底框、重复的按钮 CSS 和全局样式。
5. 引用只保留通用 inline mention/编号渲染和 PDF 页跳转，不恢复已删除的 citations 卡片或独立引用面板。

### 8.5 模块级验收标准

- 论文库模块可以完成库切换、论文列表、选择/导出 BibTeX、新建、编辑、详情、删除、移动、解析状态和预览入口，相关状态无需跨多个碎片文件追踪。
- PDF 模块保持连续滚动、滚轮逐段滚动、缩放、全屏、目标页定位和返回导航行为。
- 引用在对话正文中显示为编号形式，点击后可跳转至对应论文和 PDF 页；未知 token 安全降级为普通文本。
- 模块专属源文件不存在仅包含单一函数或少量转发的碎片；同级基础设施仍保持独立、无业务耦合。

## 9. DSH 改动分类与收敛方案

### 9.1 可以保留并上游化的通用能力

| 当前能力 | 结论 | 收敛要求 |
| --- | --- | --- |
| shell.main 与 LayoutController.registerMainView/activateMainView | 保留 | 命名保持通用，支持插件注册、激活、取消激活和卸载；不得内置 PaperAgent 页面 |
| sidebar.primary.action slot | 保留 | 只定义“新对话下方的扩展入口”位置；owner 类型改成通用名称 |
| Markdown inline mention/provider registry | 保留 | provider 由插件注册和注销；渲染器不认识论文、引用或 PaperAgent |
| assistant late turn-data 更新 | 保留但需重做 API | 提供正式的 revision/subscribe 数据存储契约，删除隐式 sentinel 类型 |
| 插件 session event 注册 | 保留并泛化 | 已提供 namespace 校验、可选 schema/decoder、引用计数和幂等 disposer；禁止 PaperAgent 业务类型进入 DSH |

### 9.2 可以删除或移回插件的改动

| 当前改动 | 处理 |
| --- | --- |
| ui-workspace 在打开 session 时直接调用 activateMainView(null) | 删除宿主改动；PaperAgent 插件订阅 session 变化并自行清除主视图 |
| DSH 中任何 PaperAgent 特定 event/type/name | 移除；由插件注册通用扩展协议 |
| 只为某个测试 fixture 增加的宿主分支 | 随测试重写删除 |
| 仅解决当前插件内部状态刷新的 sentinel 字段 | 用正式公共数据接口替换 |

### 9.3 DSH 目标公共接口

目标不是把 PaperAgent 代码搬入 DSH，而是让 DSH 提供四类最小扩展：

1. MainViewRegistry：插件注册主区域视图，激活时替换聊天区域，返回聊天时取消激活。
2. SidebarActionSlot：插件在新对话下方注册入口，支持图标、标题、active 状态和点击处理。
3. MarkdownMentionRegistry：插件注册 token 到可点击 inline node 的解析和渲染器。
4. SessionEventRegistry：插件声明事件 namespace、版本和 decoder，未知事件可安全忽略或降级。

这些接口必须通过 DSH 的公开包导出，具备单元测试、注销能力和插件重复加载测试；接口中不得出现 PaperAgent 业务类型。

## 10. 分阶段实施顺序

### C0：PaperAgent 基线与冻结

- 记录当前包导出、工具名、Remote 名、数据库 schema 版本和文件路径。
- 运行 domain/parser/tools/citation/remote 单测、PaperAgent 类型检查、构建和浏览器 E2E。
- 保存一份真实 session、论文目录和 MinerU fixture 作为回归样本。
- 建立“只允许兼容性改动”的分支或提交基线。

完成标准：基线测试可重复，所有公开契约有清单。

### C1：遗留代码与质量门禁

- 清除 noUnused 报告的生产代码：parser 常量/旧 artifact 函数、remote 注释旧下载器和旧 ArXiv 类型、adapter 未使用导入、parse-job 未使用类型。
- 增加统一 typecheck、noUnused、test:unit、test:e2e 命令。
- 配置 CI/本地脚本，禁止新增未使用导入、禁止提交生成目录。

完成标准：生产代码 noUnused 为 0；测试中的新增诊断不超过明确白名单，白名单有 issue 和期限。

### C2：Domain 拆分

- 按第 5 节新增 schema/migration/db/repository 文件。
- 将 domain.ts 改成兼容门面。
- 补齐移动、删除、替换 PDF、FTS/元素一致性和事务回归测试。

完成标准：所有 domain 测试通过，数据库快照一致，旧 import 路径仍可用。

### C3：Parser、Tools、Remote 拆分

- 按第 6、7 节拆分并保留门面。
- 删除注释代码和旧兼容路径。
- 增加 MinerU v2/legacy fixture、ZIP 安全、候选导入歧义、工具错误和 Remote 404/401 回归测试。

完成标准：工具名、返回结构和 skill 工作流不变；解析产物 source-map、elements 和 Markdown 与基线一致。

### C4：UI 拆分

- 按第 8 节拆分页面、对话框、hooks 和 PDF reader。
- 新建/编辑共用表单；解析轮询可取消；详情/编辑窗口宽度、全屏和目标页回归。
- 保持 DSH 风格组件，不引入业务级全局 CSS。

完成标准：论文库和 PDF 预览 E2E 全通过；组件卸载、切换 workspace、重复打开对话框无 stale update。

### C5：PaperAgent 集成边界确认

- 仅检查 PaperAgent 对 DSH 公开 API 的调用是否集中在适配层，不新增 DSH 源码补丁。
- 将 PaperAgent 的会话事件、主视图、侧栏入口和 mention 注册封装在插件内部，避免业务代码散落。
- 对 DSH 依赖使用固定版本和最小公开接口，记录不兼容风险但不在本计划中修复 DSH。

完成标准：PaperAgent 插件在目标 DSH 版本下可加载、卸载、重新加载；PaperAgent 内部没有跨层调用和宿主实现细节泄漏。

### C6：最终验收与扩展前检查

- 只运行 PaperAgent 的全量 typecheck、noUnused、unit、构建和必要的插件 E2E。
- 检查包依赖图，确认 domain 不依赖 UI/DSH web 实现。
- 检查生成目录、临时目录和 secrets 未被提交。
- 对比公开契约和 session 历史兼容性。

C6 门禁已完成；Elasticsearch、DashScope embedding 与 Rerank 的实施状态和后续验收统一维护在 detailed-implementation-plan.md。

## 11. 测试与质量门禁

### 11.1 静态门禁

- TypeScript strict/typecheck 通过。
- 生产源代码 noUnusedLocals、noUnusedParameters 为 0。
- 依赖检查无 domain → UI、domain → network 的反向依赖。
- 生成目录（lib、子包 node_modules、临时归档）不进入源码提交。

### 11.2 Domain/Parser/Tools 门禁

- repository CRUD、事务、移动、删除、PDF 替换和 FTS 一致性。
- MinerU 两种 content list、Markdown/chunk/source-map/elements、图片资源和失败清理。
- 工具 schema、workspace 校验、candidate_id 歧义、引用 token 和错误阶段。
- Remote 参数校验、状态码转换、文件流和路径安全。

### 11.3 PaperAgent UI/E2E 门禁

- 主视图注册/激活/取消激活和侧栏入口 slot 的 PaperAgent 使用路径。
- 论文库、论文详情/编辑、MinerU 解析状态、引用跳转和 PDF 预览。
- 插件卸载、工作区切换和重复打开对话框不会产生 stale update。
- mention provider 注册、注销、未知 token 降级和历史 session 加载。
- 论文库进入/返回对话、新建/编辑/删除/移动/导出 BibTeX。
- PDF 连续滚动、缩放、全屏、目标页初始定位。
- 插件冷启动、热重载、重复加载和卸载后无残留监听器。

## 12. 风险、回滚与发布策略

### 12.1 主要风险

- 拆分时改变 SQLite 事务边界，造成论文记录和文件不一致。
- parser 规范化顺序变化，导致 chunk_id/source-map 不兼容。
- DSH slot 或 session event 契约变化，导致旧历史无法加载。
- UI hooks 拆分后产生重复请求或未取消轮询。
- 兼容门面长期存在，导致新代码继续依赖旧大文件。

### 12.2 回滚策略

1. 每个 C 阶段独立提交，提交前必须通过本阶段门禁。
2. 新模块先以 facade 接入，出现问题时可回退到旧实现。
3. 删除旧代码前保留一次完整回归快照。
4. 只回退本次阶段修改的文件，不使用会覆盖用户其他工作的全仓库强制 reset。
5. DSH API 采用向后兼容的新增接口；旧接口至少保留一个发布周期。

### 12.3 发布策略

- 开发环境默认启用新模块，但保留内部兼容开关用于回归对比。
- 先发布 PaperAgent 插件，再单独发布 DSH 通用扩展；两者版本和最低 DSH 版本写入 manifest。
- 观察真实 session、解析失败、PDF 预览和插件重载日志后，再删除兼容开关。

## 13. Definition of Done

本计划完成时，应满足：

- PaperAgent UI 按页面/业务域形成少量完整页面模块：论文库页、PDF 阅读页、引用渲染模块；入口文件只做宿主适配和页面组合，跨页面契约保留在 shared 中。
- 生产源代码无未使用变量、导入和旧注释实现；没有重复的新建/编辑表单。
- SQLite、文件、MinerU、Agent tools、Remote、UI 之间依赖方向清晰。
- PaperAgent 仅通过 DSH 的公开主视图、侧栏 slot、Markdown mention 和会话事件接口运行；本阶段不改 DSH 源码。
- 现有论文管理、解析、检索、Agent 对话、引用跳转和 PDF 预览行为保持不变。
- PaperAgent 的静态、单元、集成和必要浏览器 E2E 门禁通过；不把 DSH 全量测试作为本项目门禁。
- 文档中的后续 Elasticsearch/多模态向量计划建立在清理后的端口之上，而不是重新穿透 domain 或 DSH 核心。

## 附录 A：DSH 历史改动记录（只读）

本附录仅用于记录此前为 PaperAgent 接入而审计过的 DSH 改动，不属于当前清理范围；后续实施不得继续修改 deepseek-harness。

以下清单对应本次审计时 deepseek-harness 工作区中检测到的未提交改动。判定标准是：能否被两个以上插件复用、是否需要宿主才能实现当前交互、是否会破坏历史 session 安全边界。

| DSH 文件/区域 | 判定 | 后续动作 |
| --- | --- | --- |
| packages/core/session/src/known-event-types.ts | 必须保留的通用能力 | 当前支持 namespace + decoder 注册、引用计数和 disposer；未知事件仍按 ignorable 契约拒绝或降级 |
| packages/core/session/src/index.ts | 必须保留公开导出 | 只导出通用 SessionEventRegistry，不导出 PaperAgent 名称 |
| scripts/gen-persistence-catalog.ts | 仅构建辅助 | 与新的事件注册机制联动；不写入业务事件白名单 |
| packages/client/ui-layout/src/client/AppFrame.tsx | 必须保留通用主区域插槽 | 修复 render 时 bind 产生的不稳定回调；支持注销和激活状态同步 |
| packages/client/ui-layout/src/client/index.ts | 必须保留 | 公开 MainViewRegistry 类型和最小 API |
| packages/client/ui-layout/src/client/service.ts | 必须保留 | 将主视图注册、激活、订阅封装成稳定服务；禁止业务判断 |
| packages/client/ui-layout 相关 tests | 必须保留 | 增加注册/注销、重复注册、激活空值和插件卸载测试 |
| packages/client/ui-sidebar/src/client/SidebarRoot.tsx | 必须保留通用 slot | 只负责渲染扩展入口，不判断论文库或插件名 |
| packages/client/ui-sidebar 相关 CSS/contract/slots/index/tests | 必须保留 | owner 类型和 slot 命名通用化；覆盖新对话下方的位置契约 |
| packages/client/ui-workspace/src/client/index.ts | 可以删除当前 PaperAgent 专用部分 | 不再由 workspace 自动清除主视图，改由插件订阅 session 变化；其余通用 workspace 逻辑保留 |
| packages/client/ui-conversation/src/client/apply.ts | 能力必须保留，但 API 需整理 | 使用正式的 turn-data revision/subscribe 接口，避免隐式类型约定 |
| packages/client/ui-conversation/src/client/AssistantNodeView.tsx | 能力必须保留 | 仅调用通用 Markdown mention/provider，不认识 citation 业务 |
| packages/client/ui-conversation/contract/index.ts | 必须保留 | 删除 turn-data-revision sentinel，改为公开数据存储契约 |
| packages/client/ui-conversation/chat/inline-code-mentions.ts | 必须保留 | 抽象为通用 inline mention registry，提供注销和未知 token 降级 |
| packages/client/ui-primitives/src/markdown/render.tsx | 必须保留 | 保证普通 Markdown 不受插件 provider 影响 |
| packages/client/ui-primitives/src/markdown/MarkdownText/index.ts | 必须保留 | 导出通用 mention 类型，避免 PaperAgent 专用类型泄漏 |
| packages/client/ui-primitives Markdown tests | 必须保留 | 增加 provider 注册、注销、未知 token 和多 provider 冲突测试 |
| DSH 测试 fixture 中的 PaperAgent 字符串 | 原则上删除 | 只有在验证通用插件事件注册时才保留抽象 fixture 名称 |

### 附录 A.1 最小 DSH 变更集

若未来 DSH 接受上游合并，最小变更集只包含四项通用能力：

1. 主内容区 MainViewRegistry。
2. 新对话下方 SidebarActionSlot。
3. Markdown inline mention/provider registry。
4. 带 schema/decoder 的 SessionEventRegistry。

PaperAgent 的论文库页面、解析状态、引用证据、MinerU 配置、PDF 阅读器、SQLite 数据访问和导入工具均不得进入 DSH。若某项宿主改动无法抽象为以上四类能力，则优先移回插件，必要时放弃该宿主改动并采用插件内降级方案。

## 附录 B：执行时的文件检查清单

每完成一个阶段，按下面顺序检查：

- [ ] 新模块有明确单一职责，入口门面不超过组合/转发职责。
- [ ] 新增依赖方向没有反向穿透；domain 不依赖 UI 或网络客户端。
- [ ] 旧入口导出和工具/Remote 契约未改变，或者有明确的兼容适配。
- [ ] 失败路径清理临时文件、取消请求并保留可诊断错误。
- [ ] 单元测试覆盖成功、失败、取消、重复调用和卸载场景。
- [ ] noUnused、typecheck、单元测试和相关 E2E 均通过。
- [ ] 没有提交 lib、node_modules、临时 ZIP、PDF、token 或 session 日志。
- [ ] 文档同步记录已完成项、兼容开关和剩余风险。

## 14. 执行记录（2026-08-31）

本节记录已经落地的清理动作；若与前文的“目标结构”存在差异，以本节和代码现状为准。

### 14.1 PaperAgent 已完成

- 当前生产源码粗略行数：`domain.ts` 约 588 行、`parser.ts` 约 401 行（网络/响应/原子文件操作已移至 `parser-utils.ts`，图片资源替换已移至 `figure-assets.ts`）、`tools/plugin.ts` 约 108 行（正文检索已移至 `search-tools.ts`，图像工具已移至 `figure-tools.ts`，导入/解析工具已移至 `paper-import-tools.ts`）、`PaperAgentViews.tsx` 约 26 行，管理页约 395 行（库/论文列表加载已移至 `usePaperCatalog.ts`，选择状态已移至 `usePaperSelection.ts`，导出逻辑已移至 `usePaperExport.ts`，论文加载请求已统一为 `loadPaper`，列表表格、详情/确认对话框、共享元数据和新建/编辑对话框、解析轮询分别位于 `PaperAgentPaperTable.tsx`、`PaperAgentPaperDetails.tsx`、`PaperAgentConfirmDialogs.tsx`、`PaperMetadataFields.tsx`、`PaperAgentPaperDialogs.tsx`、`useParseJobs.ts`）；图像/视觉持久化进一步移至 `domain/src/repositories/figure-repository.ts`，chunk/element 索引写入移至 `domain/src/repositories/index-repository.ts`，MinerU content-list 解析移至 `parser-mineru/src/content-list.ts`。第 4 节中的数字是重构前基线，不代表当前规模。
- `domain.ts` 已拆出 `inputs`、`rows`、`schema`、`normalizers`、`bibtex`、`paths`、`validation`、`row-mappers`、`search-filters`、`figure-text`，并新增 `repositories/library-repository`、`paper-repository`、`parse-job-repository`、`vision-job-repository`、`markdown-repository`、`search-repository`、`index-repository`。论文记录插入、BibTeX 读取和事务边界也已统一为 repository/helper，避免重复 SQL；`PaperAgentStore` 继续作为兼容门面。
- 论文图像记录、视觉状态、图像 FTS 同步和复用查询已移入 `repositories/figure-repository.ts`；门面只保留事务编排和兼容转发，避免把图像持久化 SQL 与论文导入流程继续堆在同一文件。
- chunk、结构化元素及其 FTS/关联表的原子替换已移入 `repositories/index-repository.ts`；解析修订仍由 `PaperAgentStore` 负责跨 chunk、figure 和论文状态协调事务。
- `parser-mineru/parser.ts` 已移除 ZIP 归档读取实现，统一由 `archive.ts` 提供安全读取、路径校验和必需文件检查。
- `parser-mineru/parser.ts` 的 MinerU v2/legacy content-list 解析、元素类型归一化和正文/图表/表格/公式字段提取已移入 `content-list.ts`；解析器主类只负责网络任务、归档编排和产物提交。
- `parser-mineru/parser.ts` 的 URL 规范化、响应解析、凭证脱敏、取消/轮询延迟和原子文件操作已移入 `parser-utils.ts`；图片资源替换及归档图片匹配统一由 `figure-assets.ts` 提供，解析器主类只保留 MinerU 请求与解析编排。
- `tools/plugin.ts` 已移除 MinerU/视觉客户端启动校验细节，统一由 `runtime.ts` 负责；论文库/论文基础查询和 BibTeX 读取工具已移入 `library-tools.ts`，结构化元素检索工具已移入 `element-search-tools.ts`；证据转换、浏览器 PDF 暂存、系统证据策略分别位于 `evidence.ts`、`browser-upload.ts`、`evidence-policy.ts`。
- `tools/plugin.ts` 的导入 PDF、URL/arXiv、候选解析和 MinerU 解析工具已移入 `paper-import-tools.ts`；图像检索、图像详情和视觉重试工具已移入 `figure-tools.ts`；正文检索已移入 `search-tools.ts`；入口文件只负责组装运行时依赖和调用各工具组注册函数。
- Remote 的论文响应映射已移入 `remote-mappers.ts`，ArXiv/PDF URL 导入流程已移入 `remote-import.ts` 并保留 `remote.ts` 兼容导出；Remote 主类继续只负责 session/workspace 校验和契约方法编排。
- UI 已完成业务模块合并和回归验证：论文库状态、加载、解析轮询、表格、详情/确认/新建编辑对话框和 BibTeX 导出已收敛在 `Library.tsx`；PDF 主阅读、抽屉、全屏、连续渲染、缩放和定位已收敛在 `Pdf.tsx`；引用事件定义已收敛在 `Citations.tsx`。解析轮询的 workspace 切换和卸载 generation 防抖保护已保留。
- UI 已移除详情页中已禁用的图片预览/视觉重试死代码；图片和视觉描述仍由 Agent 检索工具及后端队列负责，不再由未使用的详情 UI 维护状态。
- 已删除生产代码中的旧下载器注释实现、未使用常量、未使用恢复函数、无效导入和测试中的未使用变量。
- 新建和编辑继续通过同一组局部元数据字段与状态适配器复用表单 JSX；详情、确认弹窗、解析轮询和选择/导出逻辑均已回收至 `Library.tsx`，避免为单一用户工作流保留独立 wrapper 文件。
- 新增 `scripts/check-architecture.mjs`（同时暴露为 `check:architecture` 脚本），自动检查 Domain 不反向依赖 UI/DSH/网络、Parser 依赖方向保持单向；直接执行检查已通过。

### 14.2 DSH diff 审查结论（历史记录，不再执行）

以下内容仅保留审计结论，当前阶段不再修改 deepseek-harness，也不把这些条目作为 PaperAgent 清理任务。

- 保留并视为通用框架能力：`shell.main` 主区域视图注册/激活服务、`sidebar.primary.action` 侧栏扩展槽、Markdown mention provider、可扩展 session event 类型注册、turn data 变更通知所需的布局能力。
- 已移除 PaperAgent 专用耦合：`ui-workspace` 不再直接调用 `activateMainView(null)`；会话切换后的主视图复位由 PaperAgent 插件订阅 session 变化自行完成。
- DSH 中不得出现论文库、MinerU、BibTeX、PaperAgent 命名或业务 SQL；新增 API 必须保持命名空间化、可注销、可被多个插件复用。本轮源码扫描未发现这些业务词耦合。
- `turn-data-revision` 兼容性 sentinel 已移除，DSH `ConversationLocationDataStore` 现在直接提供正式的 `getSnapshot/subscribe` 契约，PaperAgent 和 deliverables 测试均已切换；session event 注册支持引用计数、幂等 disposer 和 decoder，PaperAgent 在插件卸载时释放注册。
- PaperAgent 对 session event disposer 保留了一个仅处理旧生成声明的 `asDisposer` 兼容边界；DSH 源码契约已更新并重新生成 `lib`，后续可在最低版本门槛提升后删除该边界。

### 14.3 当前验证结果与阻塞

- `node scripts/check-architecture.mjs`、`corepack pnpm run check`、严格 `noUnused` 和 Domain 14 项均通过；图像仓储拆分后再次通过严格 `noUnused`。
- 本轮进一步将 MinerU 图片资源处理抽离到 `parser-mineru/src/figure-assets.ts`，并将图像检索/详情/视觉重试工具抽离到 `tools/src/figure-tools.ts`；PaperAgent 类型检查和 Domain/Parser 定向测试再次通过。
- 本轮将正文检索、精确 Markdown 检索和章节读取工具抽离到 `tools/src/search-tools.ts`；并将 Remote 映射与 URL 导入流程分别抽离到 `remote-mappers.ts`、`remote-import.ts`，`build:host` 已通过。
- UI 的论文详情与编辑加载请求已统一为 `loadPaper`，并在生成目录权限修复后完成 `build:ui`；本轮未引入业务行为变化。
- `usePaperCatalog.ts`、`usePaperSelection.ts`、`usePaperExport.ts`、`useParseJobs.ts` 已删除；其中加载、选择、导出和可取消解析轮询逻辑均已合并至 `Library.tsx`。`paper-form.ts`、论文表格、详情、确认和编辑弹窗文件也已删除并内联，避免重复命名和跨文件追踪。
- UI 单层业务模块已完成：源码只保留 `Views.tsx`、`Library.tsx`、`Pdf.tsx`、`Citations.tsx`、`SidebarAction.tsx`、`MineruSettings.tsx` 及同级 API/导航工具文件。`corepack pnpm run check`、UI 构建和 `build:bundle` 均通过。
- DSH 仅完成新增扩展点的业务耦合扫描，结果为未发现 PaperAgent/MinerU/BibTeX 业务词；未执行 DSH 全量测试。
- 已完成 PaperAgent `build:host`、`build:ui`、`build:bundle`；构建仅更新生成产物，未手工修改 `lib`。
- 浏览器 E2E 已通过：真实 DSH Web 在 `http://127.0.0.1:3091` 启动后，侧栏可进入论文库，且“报告库/笔记库”旧入口未渲染。开发 overlay 同时修正为“覆盖 profile 已有 paperagent 行”，避免重复插入；本地测试环境补齐了缺失的工作区 junction。
- 插件 E2E 启动依赖目标 DSH 运行时；Windows 下需要确保用户 profile 可写。上述是运行环境约束，不属于 PaperAgent 业务代码。
- 本轮首次尝试在最新 UI bundle 上启动 E2E 时，普通权限因 profile 写入 `EPERM` 失败；修复工作区依赖状态并以正确权限启动后，`corepack pnpm e2e:browser` 已再次通过（`PASS browser E2E: PaperAgent library navigation`），测试进程已停止。
- DSH 全量 `vitest` 不属于本阶段验证范围，不再作为 PaperAgent 清理的阻塞项；后续只补跑 PaperAgent 受影响包的定向测试。
- PaperAgent 专属回归全部通过：Domain 14、MinerU Parser 8、Parse Jobs 4、Binary Downloader 2、Source Adapters 4、Citations 1、Research Skill 2、Writing Skill 2、Runtime Skills 3、Vision Client 2、Vision Jobs 3、Remote Contract 2。
- Remote/工具拆分后重新完成 `build:host`；Domain、Parser、Vision 和 Tools 生成产物均可正常构建。
- 详情/确认弹窗和共享元数据字段抽取后，重新执行 `check`、`build:ui`、`build:bundle`；均通过，生成目录只由构建工具更新。
- `node scripts/check-architecture.mjs` 已通过；在当前 Windows 沙箱中使用 `pnpm run check:architecture` 会先触发依赖状态校验并因临时目录权限报 EPERM，故保留 Node 直接执行作为等价验证入口。
- 通过离线方式重建 PaperAgent 工作区的生成依赖目录后，`corepack pnpm run check:architecture` 和标准 `corepack pnpm run check` 均恢复通过；未修改业务数据或源码生成目录之外的文件。

### 14.4 下一批实现顺序

1. 已建立 `@paperagent/retrieval`：`PaperRetriever` 将三类 Agent 搜索工具与 SQLite FTS 具体调用隔离；Hybrid、Elasticsearch hydrate、DashScope embedding 与可选 Rerank 均在该契约内实现，不能侵入 DSH 或工具引用协议。
2. 在 PaperAgent 内补充插件生命周期、事件解码和重复加载/卸载回归测试，验证对 DSH 公共 API 的调用边界。
3. 继续拆分 `domain.ts` 的搜索、元素和解析索引写入职责（图像/视觉仓储、论文插入和事务 helper 已完成首批拆分），目标是门面仅保留生命周期和组合逻辑。
4. 将 `plugin.ts` 剩余工具注册按 paper/search/import/citation 分组，统一执行上下文和错误转换（library、结构化元素、正文检索、图像和 import/parse 组已完成拆分；仅保留插件生命周期与组合逻辑）。
5. UI 单层业务模块合并已完成；下一步只补充上传、编辑、移动、预览和引用跳转等真实交互的浏览器 E2E，防止后续功能开发重新引入模块专属碎片文件。
6. 继续将 `remote.ts` 中的论文库、PDF 和图像 Remote handler 按契约分组；响应映射和 URL 导入已完成首批拆分，仍需保持当前 Remote 名称和参数兼容性。
