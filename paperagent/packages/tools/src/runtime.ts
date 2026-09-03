import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PaperAgentStore } from '@paperagent/domain'
import { MineruPrecisionParser } from '@paperagent/parser-mineru'
import type { MineruModelVersion, MineruPrecisionConfig } from '@paperagent/parser-mineru'
import { DeepSeekVisionClient } from '@paperagent/vision-deepseek'
import { DashScopeEmbeddingClient } from '@paperagent/embedding-dashscope'
import { normalizeElasticsearchNodeUrl, testElasticsearchConnection } from '@paperagent/retriever-elasticsearch'
import { ElasticsearchVectorIndex } from '@paperagent/retriever-elasticsearch'
import { HybridPaperRetriever, SqlitePaperRetriever } from '@paperagent/retrieval'
import { RerankingPaperRetriever } from '@paperagent/retrieval'
import { DashScopeReranker } from '@paperagent/reranker-dashscope'
import type { PaperReranker } from '@paperagent/reranker-dashscope'
import type { PaperRetriever } from '@paperagent/retrieval'
import type { ElasticsearchPluginConfig, EmbeddingPluginConfig, MineruPluginConfig, RerankerPluginConfig, VisionPluginConfig } from './config.ts'
import { PaperVisionJobs } from './vision-jobs.ts'
import { PaperEmbeddingJobs } from './embedding-jobs.ts'

/** Validates and normalizes external parser configuration at plugin startup. */
export function validateMineruConfig(config: MineruPluginConfig): MineruPrecisionConfig {
  const url = new URL(config.apiBaseUrl)
  if (url.protocol !== 'https:') throw new Error('paperagent MinerU API base URL must use HTTPS')
  if (config.modelVersion !== 'pipeline' && config.modelVersion !== 'vlm') {
    throw new Error('paperagent MinerU modelVersion must be "pipeline" or "vlm"')
  }
  return {
    apiBaseUrl: url.toString(),
    modelVersion: config.modelVersion as MineruModelVersion,
    enableOcr: config.enableOcr,
    enableFormula: config.enableFormula,
    enableTable: config.enableTable,
    pollIntervalMs: config.pollIntervalMs,
    timeoutMs: config.timeoutMs,
  }
}

export function validateMineruCredentialRef(value: string) {
  try {
    return credentialRef(value)
  } catch {
    throw new Error('paperagent MinerU apiTokenEnv must be a credential name such as MINERU_API_TOKEN')
  }
}

export function createMineruParser(ctx: Context, config: MineruPluginConfig): MineruPrecisionParser {
  const parserConfig = validateMineruConfig(config)
  const mineruCredentialRef = validateMineruCredentialRef(config.apiTokenEnv)
  return new MineruPrecisionParser({
    config: parserConfig,
    resolveApiToken: async () => {
      const resolved = await ctx.credentials.resolve(mineruCredentialRef)
      if (resolved === undefined) throw new Error(`paperagent MinerU API token is missing: configure ${mineruCredentialRef} in DSH credentials`)
      return resolved.value
    },
  })
}

export function createVisionJobs(ctx: Context, config: VisionPluginConfig, store: Promise<PaperAgentStore>): PaperVisionJobs {
  const apiBaseUrl = new URL(config.apiBaseUrl)
  if (apiBaseUrl.protocol !== 'https:') throw new Error('paperagent DeepSeek Vision API base URL must use HTTPS')
  const credential = credentialRef(config.credentialRef)
  const client = new DeepSeekVisionClient({
    apiBaseUrl: apiBaseUrl.toString(),
    model: config.model,
    resolveApiKey: async () => {
      const resolved = await ctx.credentials.resolve(credential)
      if (resolved === undefined) throw new Error(`paperagent DeepSeek API key is missing: configure ${credential}`)
      return resolved.value
    },
  })
  return new PaperVisionJobs(store, client, config.model, config.concurrency, config.timeoutMs, config.maxImageBytes, config.maxRetries)
}

/** Host-only Elasticsearch connection seam. It resolves the secret immediately before the request. */
export function createElasticsearchConnectionTester(ctx: Context, config: ElasticsearchPluginConfig | undefined) {
  if (config === undefined || config.enabled !== true) return undefined
  const endpoint = normalizeElasticsearchNodeUrl(config.nodeUrl).toString()
  const credential = credentialRef(config.apiKeyRef)
  return async () => {
    const resolved = await ctx.credentials.resolve(credential)
    if (resolved === undefined) throw new Error(`paperagent Elasticsearch API Key 未配置：请设置 ${credential}`)
    return testElasticsearchConnection({ nodeUrl: endpoint, apiKey: resolved.value, timeoutMs: config.timeoutMs })
  }
}

/**
 * The plugin configuration supplies connection parameters; the persisted
 * PaperAgent switches decide whether a newly parsed paper is indexed.
 */
export function createEmbeddingJobs(ctx: Context, embedding: EmbeddingPluginConfig | undefined, elasticsearch: ElasticsearchPluginConfig | undefined, store: Promise<PaperAgentStore>) {
  if (embedding?.enabled !== true || elasticsearch?.enabled !== true) return undefined
  const dashScopeCredential = credentialRef(embedding.credentialRef)
  const elasticsearchCredential = credentialRef(elasticsearch.apiKeyRef)
  return new PaperEmbeddingJobs(store, {
    provider: 'dashscope', model: embedding.model, dimensions: embedding.dimensions, concurrency: embedding.concurrency, indexPrefix: elasticsearch.indexPrefix, maxImageBytes: embedding.maxImageBytes,
  }, async () => {
    const [dashScopeKey, elasticsearchKey] = await Promise.all([ctx.credentials.resolve(dashScopeCredential), ctx.credentials.resolve(elasticsearchCredential)])
    if (dashScopeKey === undefined) throw new Error(`paperagent DashScope API Key 未配置：${dashScopeCredential}`)
    if (elasticsearchKey === undefined) throw new Error(`paperagent Elasticsearch API Key 未配置：${elasticsearchCredential}`)
    return {
      embedder: new DashScopeEmbeddingClient({ apiKey: dashScopeKey.value, model: embedding.model, dimensions: embedding.dimensions, timeoutMs: embedding.timeoutMs }),
      index: new ElasticsearchVectorIndex({ nodeUrl: elasticsearch.nodeUrl, apiKey: elasticsearchKey.value, timeoutMs: elasticsearch.timeoutMs }),
    }
  })
}

/**
 * Builds the Agent-facing retrieval boundary. Configuration merely makes the
 * vector capability available; the user-owned SQLite switches decide per call
 * whether HybridRetriever may resolve credentials and contact DashScope/ES.
 */
export function createPaperRetriever(
  ctx: Context,
  embedding: EmbeddingPluginConfig | undefined,
  elasticsearch: ElasticsearchPluginConfig | undefined,
  reranker: RerankerPluginConfig | undefined,
  store: Promise<PaperAgentStore>,
): PaperRetriever {
  const base = embedding?.enabled !== true || elasticsearch?.enabled !== true
    ? new SqlitePaperRetriever(store)
    : createHybridRetriever(ctx, embedding, elasticsearch, store)
  if (reranker === undefined || !reranker.enabled) return base
  return new RerankingPaperRetriever(base, createPaperReranker(ctx, reranker), {
    candidateLimit: reranker.candidateLimit,
    topN: reranker.topN,
    includeFigureImages: reranker.includeFigureImages,
    ...(reranker.includeFigureImages ? {
      loadFigureImage: async figure => loadFigureImage(figure.imagePath, reranker.maxImageBytes),
    } : {}),
    ...(reranker.instruct === undefined ? {} : { instruct: reranker.instruct }),
    isEnabled: async () => (await store).getVectorSettings().rerankerEnabled,
  })
}

async function loadFigureImage(path: string, maxBytes: number): Promise<string | undefined> {
  let bytes: Buffer
  try { bytes = await readFile(path) } catch { return undefined }
  if (bytes.byteLength > maxBytes) return undefined
  const mime = imageMime(extname(path))
  return mime === undefined ? undefined : `data:${mime};base64,${bytes.toString('base64')}`
}

function imageMime(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.bmp': return 'image/bmp'
    case '.tif': case '.tiff': return 'image/tiff'
    case '.ico': return 'image/x-icon'
    default: return undefined
  }
}

function createHybridRetriever(
  ctx: Context,
  embedding: EmbeddingPluginConfig,
  elasticsearch: ElasticsearchPluginConfig,
  store: Promise<PaperAgentStore>,
): PaperRetriever {
  const dashScopeCredential = credentialRef(embedding.credentialRef)
  const elasticsearchCredential = credentialRef(elasticsearch.apiKeyRef)
  return new HybridPaperRetriever(store, {
    async embedQuery(query) {
      const settings = (await store).getVectorSettings()
      if (!settings.embeddingEnabled || !settings.elasticsearchEnabled) {
        throw new Error('vector retrieval is disabled in PaperAgent settings')
      }
      const key = await ctx.credentials.resolve(dashScopeCredential)
      if (key === undefined) throw new Error(`DashScope API Key is not configured: ${dashScopeCredential}`)
      // `embed()` is the stable adapter primitive used by the indexing worker
      // as well.  Keep query retrieval on that same operation so a stale
      // separately-built adapter cannot silently remove vector retrieval.
      return new DashScopeEmbeddingClient({
        apiKey: key.value, model: embedding.model, dimensions: embedding.dimensions, timeoutMs: embedding.timeoutMs,
      }).embed({ text: query })
    },
    async searchChunks(input) {
      const settings = (await store).getVectorSettings()
      if (!settings.embeddingEnabled || !settings.elasticsearchEnabled) {
        throw new Error('vector retrieval is disabled in PaperAgent settings')
      }
      const key = await ctx.credentials.resolve(elasticsearchCredential)
      if (key === undefined) throw new Error(`Elasticsearch API Key is not configured: ${elasticsearchCredential}`)
      const index = new ElasticsearchVectorIndex({ nodeUrl: elasticsearch.nodeUrl, apiKey: key.value, timeoutMs: elasticsearch.timeoutMs })
      return index.searchKnn({
        index: `${elasticsearch.indexPrefix}-chunks-v1`, vector: input.vector, workspaceKey: input.workspaceKey,
        limit: input.limit, ...(input.filter.libraryId === undefined ? {} : { libraryId: input.filter.libraryId }),
        ...(input.filter.paperIds === undefined ? {} : { paperIds: input.filter.paperIds }),
        ...(input.filter.section === undefined ? {} : { section: input.filter.section }), sourceKind: 'chunk',
      })
    },
    async searchElements(input) {
      const settings = (await store).getVectorSettings()
      if (!settings.embeddingEnabled || !settings.elasticsearchEnabled) {
        throw new Error('vector retrieval is disabled in PaperAgent settings')
      }
      const key = await ctx.credentials.resolve(elasticsearchCredential)
      if (key === undefined) throw new Error(`Elasticsearch API Key is not configured: ${elasticsearchCredential}`)
      const index = new ElasticsearchVectorIndex({ nodeUrl: elasticsearch.nodeUrl, apiKey: key.value, timeoutMs: elasticsearch.timeoutMs })
      return index.searchKnn({
        index: `${elasticsearch.indexPrefix}-elements-v1`, vector: input.vector, workspaceKey: input.workspaceKey,
        limit: input.limit, ...(input.filter.libraryId === undefined ? {} : { libraryId: input.filter.libraryId }),
        ...(input.filter.paperIds === undefined ? {} : { paperIds: input.filter.paperIds }),
        ...(input.filter.section === undefined ? {} : { section: input.filter.section }),
        ...(input.types === undefined ? {} : { elementTypes: input.types }), sourceKind: 'element',
      })
    },
  })
}

function createPaperReranker(ctx: Context, config: RerankerPluginConfig): PaperReranker {
  if (config.model !== 'auto' && config.model !== 'qwen3-rerank' && config.model !== 'qwen3-vl-rerank') {
    throw new Error('paperagent reranker model must be auto, qwen3-rerank or qwen3-vl-rerank')
  }
  const endpoint = new URL(config.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('paperagent reranker endpoint must use HTTPS')
  const credential = credentialRef(config.credentialRef)
  return {
    rerank: async input => {
      const resolved = await ctx.credentials.resolve(credential)
      if (resolved === undefined) throw new Error('paperagent DashScope API Key is not configured: ' + credential)
      const hasImage = input.query.imageDataUri !== undefined || input.documents.some(document => document.imageDataUri !== undefined)
      const model = config.model === 'auto' ? (hasImage ? 'qwen3-vl-rerank' : 'qwen3-rerank') : config.model
      return new DashScopeReranker({
        apiKey: resolved.value,
        endpoint: endpoint.toString(),
        model,
        timeoutMs: config.timeoutMs,
      }).rerank(input)
    },
  }
}

export function requireWorkspace(cwd: string | undefined): string {
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('PaperAgent requires a DSH workspace. Select a project before using paper tools.')
  }
  return cwd
}
