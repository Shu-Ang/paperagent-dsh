# PaperAgent DSH

PaperAgent DSH 是一个本地优先的论文研究助手，由两个源码目录组成：

- `deepseek-harness/`：DeepSeek Harness 核心框架。
- `paperagent/`：基于 DSH 的 PaperAgent 插件，提供论文导入、MinerU 解析、文本/元素切片、SQLite 全文检索、可选 Elasticsearch 向量检索、DashScope 重排以及论文引用预览等能力。

## 目录约定

运行时数据、SQLite 数据库、论文 PDF/Markdown/图片、模型 Token、Elasticsearch 数据和构建产物均不提交到 Git。具体规则见根目录 `.gitignore`。

两个源码目录中的独立 Git 元数据不会提交；本仓库使用根目录 Git 管理两个源码树。旧工作区和恢复副本如仍存在，也会被 `.gitignore` 排除。

## 环境要求

- Windows 10/11
- Node.js 22.19+ 或 Node.js 24+
- Corepack / pnpm 11
- 可选：Docker Desktop（运行 Elasticsearch）

## 安装与构建

先安装 DeepSeek Harness：

```powershell
cd deepseek-harness
corepack pnpm install
corepack pnpm build:lib
```

再安装 PaperAgent 插件依赖并构建：

```powershell
cd ..\paperagent
corepack pnpm install
corepack pnpm build
```

首次使用或目录移动后，需要把本地 PaperAgent bundle 重新安装到 DSH 的 `web` profile。先移除 profile 中可能存在的旧路径，再添加新路径：

```powershell
cd ..\deepseek-harness
corepack pnpm dsh plugin --profile web remove @paperagent/dsh-paperagent
corepack pnpm dsh plugin --profile web add ..\paperagent\packages\bundle
```

该命令会更新 `C:\Users\<用户名>\.dsh\profiles\web` 中的本地依赖链接；真实凭据仍保存在 DSH 用户目录，不进入本仓库。

## 启动

```powershell
cd paperagent
corepack pnpm dev
```

或者直接从 DSH 目录启动，并加载 PaperAgent 配置：

```powershell
cd ..\deepseek-harness
corepack pnpm dsh web --patch ..\paperagent\config\paperagent.dev.yml --port 3091
```

真实凭据应通过 DSH 的设置界面或用户目录下的凭据文件配置，不要写入仓库。PaperAgent 的 MinerU、DashScope 和 Elasticsearch 配置应优先使用本地配置文件，并以 `.example` 文件提供脱敏模板。

## Git 提交范围

提交前只应包含：

```text
deepseek-harness/
paperagent/
.gitignore
README.md
```

提交前请检查：

```powershell
git status --short
git diff --cached --name-only
```
