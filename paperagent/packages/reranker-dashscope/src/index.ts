/** Provider-neutral input/output for DashScope text and vision reranking. */

export type DashScopeRerankModel = 'qwen3-rerank' | 'qwen3-vl-rerank'

export interface RerankDocument {
  readonly sourceId: string
  readonly text: string
  /** Optional image Data URI. Its presence selects the vision endpoint. */
  readonly imageDataUri?: string
}

export interface RerankQuery {
  readonly text?: string
  readonly imageDataUri?: string
}

export interface RerankResult {
  readonly sourceId: string
  readonly index: number
  readonly relevanceScore: number
}

export interface PaperReranker {
  rerank(input: {
    readonly query: RerankQuery
    readonly documents: readonly RerankDocument[]
    readonly topN: number
    readonly instruct?: string
  }): Promise<readonly RerankResult[]>
}

export interface DashScopeRerankerOptions {
  readonly apiKey: string
  /** Base endpoint, for example https://workspace.cn-beijing.maas.aliyuncs.com. */
  readonly endpoint: string
  readonly model: DashScopeRerankModel
  readonly timeoutMs: number
  readonly fetch?: typeof fetch
}

interface ApiResult {
  readonly index: number
  readonly relevanceScore: number
}

const TEXT_PATH = '/compatible-api/v1/reranks'
const VISION_PATH = '/api/v1/services/rerank/text-rerank/text-rerank'

/**
 * Minimal DashScope Rerank adapter.
 *
 * The adapter receives prepared image Data URIs. It does not access the
 * filesystem, credentials store, SQLite, or PaperAgent.
 */
export class DashScopeReranker implements PaperReranker {
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: DashScopeRerankerOptions) {
    const endpoint = options.endpoint.trim().replace(/\/+$/, '')
    if (endpoint === '') throw new Error('DashScope rerank endpoint is missing')
    let parsed: URL
    try { parsed = new URL(endpoint) } catch { throw new Error('DashScope rerank endpoint is invalid') }
    if (parsed.protocol !== 'https:') throw new Error('DashScope rerank endpoint must use HTTPS')
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
      throw new Error('DashScope rerank timeout must be at least 1000ms')
    }
    if (options.apiKey.trim() === '') throw new Error('DashScope API key is missing')
    this.endpoint = endpoint
    this.fetchImpl = options.fetch ?? fetch
  }

  async rerank(input: {
    readonly query: RerankQuery
    readonly documents: readonly RerankDocument[]
    readonly topN: number
    readonly instruct?: string
  }): Promise<readonly RerankResult[]> {
    if (input.documents.length === 0) return []
    const topN = boundedInteger(input.topN, 1, input.documents.length)
    const useVision = input.query.imageDataUri !== undefined
      || input.documents.some(document => document.imageDataUri !== undefined)
    if (useVision && this.options.model !== 'qwen3-vl-rerank') {
      throw new Error('vision rerank documents require model qwen3-vl-rerank')
    }
    if (this.options.model === 'qwen3-vl-rerank') {
      const imageCount = input.documents.filter(document => document.imageDataUri !== undefined).length
      if (imageCount > 40) throw new Error('qwen3-vl-rerank accepts at most 40 image documents per request')
      if (input.documents.length > 100) throw new Error('qwen3-vl-rerank accepts at most 100 documents per request')
    }
    return this.options.model === 'qwen3-vl-rerank'
      ? this.requestVision(input, topN)
      : this.requestText(input, topN)
  }

  private async requestText(input: {
    readonly query: RerankQuery
    readonly documents: readonly RerankDocument[]
    readonly topN: number
    readonly instruct?: string
  }, topN: number): Promise<readonly RerankResult[]> {
    const query = textQuery(input.query)
    const documents = input.documents.map(document => {
      if (document.imageDataUri !== undefined) throw new Error('qwen3-rerank only accepts text documents')
      return requireText(document.text)
    })
    const payload = {
      model: 'qwen3-rerank',
      query,
      documents,
      top_n: topN,
      ...(input.instruct === undefined || input.instruct.trim() === '' ? {} : { instruct: input.instruct.trim() }),
    }
    const result = await this.post(TEXT_PATH, payload, input.documents.length, topN)
    return mapResults(result, input.documents)
  }

  private async requestVision(input: {
    readonly query: RerankQuery
    readonly documents: readonly RerankDocument[]
    readonly topN: number
    readonly instruct?: string
  }, topN: number): Promise<readonly RerankResult[]> {
    const query = input.query.imageDataUri === undefined
      ? { text: requireText(input.query.text ?? '') }
      : { image: validateImageDataUri(input.query.imageDataUri) }
    const documents = input.documents.map(document => document.imageDataUri === undefined
      ? { text: requireText(document.text) }
      : { image: validateImageDataUri(document.imageDataUri) })
    const payload = {
      model: 'qwen3-vl-rerank',
      input: { query, documents },
      parameters: {
        top_n: topN,
        ...(input.instruct === undefined || input.instruct.trim() === '' ? {} : { instruct: input.instruct.trim() }),
      },
    }
    const result = await this.post(VISION_PATH, payload, input.documents.length, topN)
    return mapResults(result, input.documents)
  }

  private async post(path: string, payload: unknown, documentCount: number, topN: number): Promise<readonly ApiResult[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await this.fetchImpl(this.endpoint + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error('DashScope rerank failed with HTTP ' + response.status + errorSuffix(body))
      return readResults(body, this.options.model, documentCount, topN)
    } catch (error) {
      if (controller.signal.aborted) throw new Error('DashScope rerank timed out after ' + this.options.timeoutMs + 'ms')
      throw error
    } finally { clearTimeout(timer) }
  }
}

function mapResults(results: readonly ApiResult[], documents: readonly RerankDocument[]): readonly RerankResult[] {
  return results.map(result => ({
    sourceId: documents[result.index]!.sourceId,
    index: result.index,
    relevanceScore: result.relevanceScore,
  }))
}

function readResults(payload: unknown, model: DashScopeRerankModel, documentCount: number, topN: number): readonly ApiResult[] {
  if (!isRecord(payload)) throw new Error('DashScope rerank returned an invalid response')
  // DashScope's native VL endpoint currently returns `results` at the top
  // level; accept the older wrapped `output.results` shape as well so a
  // compatible gateway does not make the whole retrieval call fail.
  const raw = Array.isArray(payload.results)
    ? payload.results
    : model === 'qwen3-vl-rerank' && isRecord(payload.output)
      ? payload.output.results
      : undefined
  if (!Array.isArray(raw)) throw new Error('DashScope rerank response is missing results')
  if (raw.length > topN) throw new Error('DashScope rerank returned more results than top_n')
  const seen = new Set<number>()
  return raw.map((item, resultIndex) => {
    if (!isRecord(item) || !Number.isSafeInteger(item.index) || item.index < 0
      || (documentCount !== undefined && item.index >= documentCount)
      || seen.has(item.index) || typeof item.relevance_score !== 'number'
      || !Number.isFinite(item.relevance_score) || item.relevance_score < 0 || item.relevance_score > 1) {
      throw new Error('DashScope rerank returned an invalid result at index ' + resultIndex)
    }
    seen.add(item.index)
    return { index: item.index, relevanceScore: item.relevance_score }
  })
}

function textQuery(query: RerankQuery): string {
  if (query.imageDataUri !== undefined) throw new Error('qwen3-rerank does not accept an image query')
  return requireText(query.text ?? '')
}

function requireText(value: string): string {
  const text = value.trim()
  if (text === '') throw new Error('rerank text must not be blank')
  return text
}

function validateImageDataUri(value: string): string {
  if (!/^data:image\/(?:png|jpeg|jpg|webp|bmp|tiff|ico|dib|icns|sgi);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
    throw new Error('rerank image must be a supported base64 image Data URI')
  }
  return value
}

function errorSuffix(payload: unknown): string {
  if (!isRecord(payload) || (typeof payload.code !== 'string' && typeof payload.message !== 'string')) return ''
  const code = typeof payload.code === 'string' ? payload.code : ''
  const message = typeof payload.message === 'string' ? payload.message : ''
  const detail = [code, message].filter(Boolean).join(' - ').slice(0, 300)
  return detail === '' ? '' : ': ' + detail
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error('rerank topN must be finite')
  return Math.min(Math.max(Math.trunc(value), min), max)
}
