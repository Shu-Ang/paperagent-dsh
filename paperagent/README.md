# PaperAgent DSH

基于 DeepSeek Harness（DSH）重构的本地优先个人论文助手。论文、SQLite 与解析产物保存在本机；PDF 解析时会调用用户配置的 MinerU 精准 API。

当前已提供可加载的 DSH ESM bundle、独立 SQLite 领域库、受控 PDF 导入、PDF→Markdown 解析和可定位的本地文献检索。实施方案见 [docs/architecture-plan.md](docs/architecture-plan.md)，按用户流程展开的实现细节见 [docs/detailed-implementation-plan.md](docs/detailed-implementation-plan.md)。

目标：以 TypeScript、SQLite 和 DSH 的插件式 Agent 架构，提供论文库、PDF 转 Markdown、本地文件管理、Agent 对话、会话记忆及可回放轨迹；不使用 Spring AI、PostgreSQL、Redis 或 pgvector，也不保留 PDF.js、Poppler 或其他本地 PDF 解析器。该项目不修改或迁移 DSH 核心代码，也不包含旧 PostgreSQL 数据迁移。

## 当前功能

- `create_paper_library`、`list_paper_libraries`、`list_papers`：按 DSH 工作区隔离论文库。
- `import_paper_pdf`：仅导入工作区内的 PDF，SHA-256 去重并复制到 `.paperagent/papers/<id>/original.pdf`。
- `parse_paper_to_markdown`：通过配置在 DSH Host 中的 MinerU 精准 API 生成含页码、章节、Markdown 行号与结构化元素关联的 `paper.md` 和 `source-map.json`；原始 PDF 与最终产物仍存于本机。
- `search_paper_library`：返回标题、章节、PDF 页码、Markdown 行范围和原文摘录；DSH 将它显示为可展开的 Search Card，并随会话轨迹保存。
- 可选 DashScope Rerank：在 SQLite/Elasticsearch-RRF 召回后调用 `qwen3-rerank`；候选包含图片且开启图片出站时，`auto` 路由会改用 `qwen3-vl-rerank`。服务失败自动回退，检索视图可查看 rerank 分数。
- `packages/ui`：DSH Web 左侧栏新增“论文库”入口。论文页按当前工作区展示论文库与解析状态；Markdown 文件可直接使用 DSH 内置文件编辑能力管理。

## 包边界

```text
packages/
  domain/        # SQLite schema、论文库/论文领域模型与文件边界
  parser-mineru/ # MinerU 精准 API → Markdown、页码、行号与结构化 source-map
  tools/         # Agent 工具、证据提示词、PaperAgent Typert Remote BFF
  ui/            # DSH Web 左侧入口与论文管理页
  bundle/        # 唯一可安装的 DSH bundle；只组合 packages，不含业务实现
```

根目录不再承载业务 `src` 实现；它只保留工作区脚本、测试、文档和开发配置。

这是一个 pnpm workspace：根目录只有 `pnpm-lock.yaml`，依赖只需在根目录执行一次 `corepack pnpm install`。子包出现的 `node_modules` 是 pnpm 为直接依赖创建的链接目录，实际依赖缓存仍位于根 `node_modules/.pnpm`；这些目录与所有 `lib` 都是构建产物，已由 `.gitignore` 忽略。

## 安装并加载页面

MinerU Token 与 DeepSeek Key 使用同一个 DSH 凭据库。在 `C:\Users\10299\.dsh\.credentials.yaml` 添加一行（不要添加 `refs:` 或 `version:` 包装层）：

```yaml
DEEPSEEK_API_KEY: '你的 DeepSeek Key'
MINERU_API_TOKEN: '你的 MinerU 精准解析 API Token'
```

插件配置只保存凭据名 `paperagent.mineru.apiTokenEnv: MINERU_API_TOKEN`，不会保存或向浏览器发送 Token。每次开始解析时，Host 才从凭据库读取该值；缺失时该解析任务会返回明确错误。

也可以在 DSH 网页端打开 **设置 → PaperAgent → MinerU Token** 直接保存或清除 Token。该表单是只写的：页面仅显示“已配置/未配置”，不会回显密钥。

DashScope API Key 同样可在 **设置 → PaperAgent → DashScope API Key** 中保存。启用 Rerank 的开关与 Embedding 独立；Rerank 的模型、候选数和图片出站策略由 `reranker` 配置控制，默认配置使用 `model: auto`。

### DeepSeek 图片对话与论文图片描述

论文图片描述与 DSH 图片对话都复用上面的 `DEEPSEEK_API_KEY`。在 `config/paperagent.dev.yml`（或安装后的 bundle 配置）中，将 `paperagent.vision.enabled` 改为 `true`，即可在 MinerU 解析完成后异步生成图片描述；失败不会影响论文 Markdown 与检索状态。

若要让 DSH 对话框直接接受图片，请把 [config/deepseek-vision.settings.example.yml](config/deepseek-vision.settings.example.yml) 的 `llm-pi-ai` 段合并到现有的 `$DSH_HOME/settings.yaml`，随后在模型选择器中显式选用 `DeepSeek-V4-Flash-Vision-Exp`。该模型清单是替换式配置，示例已保留常用文本模型；不要把 API Key 写进 `settings.yaml`。

浏览器端插件必须以 **bundle 包** 安装，不能只用 `file:///.../lib/plugin.mjs` 的 source patch。后者只能加载 Host 工具；bundle 会将 `packages/ui` 的浏览器产物发布为自身的 `dsh.client`。

```powershell
Set-Location D:\workspace\paperagent-dsh
corepack pnpm install
corepack pnpm run build

Set-Location ..\deepseek-harness
# 仅首次执行；会复用现有 DSH_HOME/profile，不创建新的 home
corepack pnpm dsh plugin --profile web add ..\paperagent-dsh\packages\bundle
corepack pnpm dsh web --port 3091
```

重启页面后，在左侧栏底部会看到“论文库”。先选择一个 DSH 项目并打开对话，页面才会绑定到该工作区的数据。

## 开发

在 `deepseek-harness` 与本目录均已安装依赖的前提下：

```powershell
corepack pnpm run check
corepack pnpm run test:domain
corepack pnpm run build

# 复用现有 DSH_HOME，以 DSH 源码仓库的完整依赖树启动
Set-Location ../deepseek-harness
corepack pnpm dsh web --patch ../paperagent-dsh/config/paperagent.dev.yml
```

开发 patch 使用编译产物 `packages/bundle/lib/plugin.mjs`；修改 TypeScript 后先执行 `corepack pnpm run build`。生产安装使用 [packages/bundle/cordis.patch.yml](packages/bundle/cordis.patch.yml) 中的 bundle 配置。
