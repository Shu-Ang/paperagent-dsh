import Schema from '@deepseek-ai/schemastery'
import { VISION_MODEL } from '@paperagent/vision-deepseek'

export interface MineruPluginConfig {
  readonly apiBaseUrl: string
  /** Credential reference, stored alongside DeepSeek keys in DSH_HOME/.credentials.yaml. */
  readonly apiTokenEnv: string
  readonly modelVersion: string
  readonly enableOcr: boolean
  readonly enableFormula: boolean
  readonly enableTable: boolean
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export interface Config {
  readonly databasePath: string
  readonly maxPdfBytes: number
  readonly downloadTimeoutMs: number
  readonly maxDownloadRedirects: number
  readonly mineru: MineruPluginConfig
  readonly vision?: VisionPluginConfig
  /** Optional DashScope embedding settings. Disabled until the index pipeline exists. */
  readonly embedding?: EmbeddingPluginConfig
  /** Optional Elasticsearch endpoint for the derived vector index. */
  readonly elasticsearch?: ElasticsearchPluginConfig
  /** Optional DashScope final reranking stage. */
  readonly reranker?: RerankerPluginConfig
}

export interface VisionPluginConfig {
  readonly enabled: boolean
  readonly apiBaseUrl: string
  readonly credentialRef: string
  readonly model: string
  readonly concurrency: number
  readonly timeoutMs: number
  readonly maxImageBytes: number
  readonly maxRetries: number
}

export interface EmbeddingPluginConfig {
  readonly enabled: boolean
  readonly credentialRef: string
  readonly model: string
  readonly dimensions: number
  readonly concurrency: number
  readonly timeoutMs: number
  readonly maxImageBytes: number
}

export interface ElasticsearchPluginConfig {
  readonly enabled: boolean
  readonly nodeUrl: string
  readonly apiKeyRef: string
  readonly timeoutMs: number
  readonly indexPrefix: string
}

export interface RerankerPluginConfig {
  readonly enabled: boolean
  readonly credentialRef: string
  readonly model: 'auto' | 'qwen3-rerank' | 'qwen3-vl-rerank'
  readonly endpoint: string
  readonly candidateLimit: number
  readonly topN: number
  readonly timeoutMs: number
  readonly includeFigureImages: boolean
  readonly maxImageBytes: number
  readonly instruct?: string
}

/** Validated DSH loader configuration for the PaperAgent plugin. */
export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().required(),
  maxPdfBytes: Schema.natural().min(1).max(200 * 1024 * 1024).required(),
  downloadTimeoutMs: Schema.natural().min(1_000).max(5 * 60_000).default(60_000),
  maxDownloadRedirects: Schema.natural().min(0).max(10).default(3),
  mineru: Schema.object({
    apiBaseUrl: Schema.string().required(),
    apiTokenEnv: Schema.string().required(),
    modelVersion: Schema.string().required(),
    enableOcr: Schema.boolean().default(false),
    enableFormula: Schema.boolean().default(true),
    enableTable: Schema.boolean().default(true),
    pollIntervalMs: Schema.natural().min(250).default(3_000),
    timeoutMs: Schema.natural().min(1_000).default(10 * 60_000),
  }).required(),
  vision: Schema.object({
    enabled: Schema.boolean().default(false),
    apiBaseUrl: Schema.string().default('https://api.deepseek.com'),
    credentialRef: Schema.string().default('DEEPSEEK_API_KEY'),
    model: Schema.string().default(VISION_MODEL),
    concurrency: Schema.natural().min(1).max(4).default(2),
    timeoutMs: Schema.natural().min(1_000).max(120_000).default(45_000),
    maxImageBytes: Schema.natural().min(64 * 1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),
    maxRetries: Schema.natural().min(0).max(3).default(1),
  }),
  embedding: Schema.object({
    enabled: Schema.boolean().default(false),
    credentialRef: Schema.string().default('DASHSCOPE_API_KEY'),
    model: Schema.string().default('qwen3-vl-embedding'),
    dimensions: Schema.natural().min(64).max(4096).default(1024),
    concurrency: Schema.natural().min(1).max(4).default(2),
    timeoutMs: Schema.natural().min(1_000).max(120_000).default(30_000),
    maxImageBytes: Schema.natural().min(64 * 1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),
  }),
  elasticsearch: Schema.object({
    enabled: Schema.boolean().default(false),
    nodeUrl: Schema.string().default('http://127.0.0.1:9200'),
    apiKeyRef: Schema.string().default('PAPERAGENT_ES_API_KEY'),
    timeoutMs: Schema.natural().min(1_000).max(30_000).default(5_000),
    indexPrefix: Schema.string().default('paperagent'),
  }),
  reranker: Schema.object({
    enabled: Schema.boolean().default(false),
    credentialRef: Schema.string().default('DASHSCOPE_API_KEY'),
    model: Schema.union([Schema.const('auto'), Schema.const('qwen3-rerank'), Schema.const('qwen3-vl-rerank')]).default('auto'),
    endpoint: Schema.string().default('https://dashscope.aliyuncs.com'),
    candidateLimit: Schema.natural().min(1).max(50).default(20),
    topN: Schema.natural().min(1).max(20).default(6),
    timeoutMs: Schema.natural().min(1_000).max(120_000).default(30_000),
    includeFigureImages: Schema.boolean().default(false),
    maxImageBytes: Schema.natural().min(64 * 1024).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
    instruct: Schema.string(),
  }),
})
