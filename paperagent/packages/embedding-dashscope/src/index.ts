/** DashScope qwen3-vl-embedding adapter. Secrets are resolved by the Host caller. */

export interface DashScopeEmbeddingConfig {
  readonly apiKey: string
  readonly model: string
  readonly dimensions: number
  readonly timeoutMs: number
  /** Optional endpoint/fetch seams for proxies, private gateways, and tests. */
  readonly apiBaseUrl?: string
  readonly fetch?: typeof globalThis.fetch
}

export interface DashScopeEmbeddingInput {
  readonly text: string
  readonly image?: { readonly bytes: Uint8Array; readonly mimeType: string }
}

export class DashScopeEmbeddingClient {
  private readonly endpoint: URL
  private readonly request: typeof globalThis.fetch

  constructor(private readonly config: DashScopeEmbeddingConfig) {
    this.endpoint = new URL(config.apiBaseUrl ?? 'https://dashscope.aliyuncs.com')
    if (this.endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(this.endpoint.hostname)) {
      throw new Error('DashScope embedding endpoint must use HTTPS except for local development')
    }
    this.request = config.fetch ?? globalThis.fetch
  }

  /** Embeds a user query in the same text space used by chunk indexing. */
  async embedQuery(text: string): Promise<readonly number[]> {
    return this.embed({ text })
  }

  async embed(input: DashScopeEmbeddingInput): Promise<readonly number[]> {
    if (input.text.trim() === '') throw new Error('embedding input text must not be blank')
    const contents: Array<{ readonly text?: string; readonly image?: string }> = [{ text: input.text }]
    if (input.image !== undefined) contents.push({ image: `data:${input.image.mimeType};base64,${Buffer.from(input.image.bytes).toString('base64')}` })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const target = new URL('/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding', this.endpoint)
      const response = await this.request(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, input: { contents }, parameters: { enable_fusion: input.image !== undefined, dimension: this.config.dimensions } }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`DashScope embedding failed: HTTP ${response.status} ${response.statusText}`)
      const payload: unknown = await response.json()
      const vector = readVector(payload)
      if (vector.length !== this.config.dimensions) throw new Error(`DashScope embedding dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`)
      return vector
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`DashScope embedding timed out after ${this.config.timeoutMs}ms`)
      throw error
    } finally { clearTimeout(timer) }
  }
}

function readVector(payload: unknown): readonly number[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('DashScope returned an invalid embedding response')
  const output = (payload as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) throw new Error('DashScope returned no embedding output')
  const embeddings = (output as { embeddings?: unknown }).embeddings
  if (!Array.isArray(embeddings) || embeddings.length !== 1) throw new Error('DashScope returned an unexpected embedding count')
  const vector = (embeddings[0] as { embedding?: unknown } | undefined)?.embedding
  if (!Array.isArray(vector) || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('DashScope returned an invalid embedding vector')
  return vector as readonly number[]
}
