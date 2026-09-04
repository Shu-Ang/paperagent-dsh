/** Minimal Elasticsearch transport used by PaperAgent's optional vector extension. */

export interface ElasticsearchConnectionConfig {
  /** A local HTTP endpoint or any HTTPS Elasticsearch endpoint. */
  readonly nodeUrl: string
  /** Elasticsearch's write-only `encoded` API key. */
  readonly apiKey: string
  readonly timeoutMs: number
}

export interface ElasticsearchConnectionInfo {
  readonly nodeName: string
  readonly clusterName: string
  readonly version: string
}

export interface ElasticsearchVectorDocument {
  readonly id: string
  readonly workspaceKey: string
  readonly libraryId: string | null
  readonly paperId: string
  readonly sourceId: string
  readonly sourceKind: 'chunk' | 'element'
  readonly title: string
  readonly section: string
  readonly pdfPageStart: number
  readonly pdfPageEnd: number
  readonly elementType?: string
  readonly caption?: string
  readonly contentRevision: string
  readonly embeddingProvider?: string
  readonly embeddingModel?: string
  readonly embedding?: readonly number[]
}

/** A minimal, backend-neutral vector candidate. Local SQLite must hydrate it before use. */
export interface ElasticsearchVectorCandidate {
  readonly sourceId: string
  readonly sourceKind: 'chunk' | 'element'
  readonly paperId: string
  readonly score: number
}

/** Candidate returned by the Elastic lexical/BM25 projection. */
export interface ElasticsearchTextCandidate {
  readonly sourceId: string
  readonly sourceKind: 'chunk' | 'element'
  readonly paperId: string
  readonly score: number
}

export interface ElasticsearchKnnSearchInput {
  readonly index: string
  readonly vector: readonly number[]
  readonly workspaceKey: string
  readonly limit: number
  readonly libraryId?: string
  readonly paperIds?: readonly string[]
  readonly section?: string
  readonly elementTypes?: readonly string[]
  readonly sourceKind?: 'chunk' | 'element'
}

export interface ElasticsearchTextSearchInput {
  readonly index: string
  readonly query: string
  readonly workspaceKey: string
  readonly limit: number
  readonly libraryId?: string
  readonly paperIds?: readonly string[]
  readonly section?: string
  readonly elementTypes?: readonly string[]
  readonly sourceKind?: 'chunk' | 'element'
}

/** Validates the endpoint before a credential-bearing request can be sent. */
export function normalizeElasticsearchNodeUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Elasticsearch 地址必须是完整 URL，例如 http://127.0.0.1:9200。')
  }
  const localHttpHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttpHosts.has(url.hostname))) {
    throw new Error('Elasticsearch 地址必须使用 HTTPS；仅本机 localhost/127.0.0.1 允许 HTTP。')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Elasticsearch 地址不能包含用户名或密码。')
  return url
}

/**
 * Verifies a configured Elasticsearch endpoint without exposing its API key.
 * The body is deliberately ignored on failures: proxies sometimes echo request
 * details and that must not become a browser-visible error or a session log.
 */
export async function testElasticsearchConnection(config: ElasticsearchConnectionConfig): Promise<ElasticsearchConnectionInfo> {
  const nodeUrl = normalizeElasticsearchNodeUrl(config.nodeUrl)
  const apiKey = config.apiKey.trim()
  if (apiKey === '') throw new Error('Elasticsearch API Key 未配置。')
  const target = new URL(nodeUrl)
  target.pathname = `${target.pathname.replace(/\/$/, '')}/`
  target.search = ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `ApiKey ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Elasticsearch 连接失败：HTTP ${response.status} ${response.statusText}`)
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('Elasticsearch 返回了无效的节点信息。')
    }
    const result = payload as { name?: unknown; cluster_name?: unknown; version?: { number?: unknown } }
    if (typeof result.name !== 'string' || typeof result.cluster_name !== 'string' || typeof result.version?.number !== 'string') {
      throw new Error('Elasticsearch 返回缺少节点名称、集群名称或版本号。')
    }
    return { nodeName: result.name, clusterName: result.cluster_name, version: result.version.number }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Elasticsearch 连接超时（${config.timeoutMs}ms）。`)
    const detail = error instanceof Error ? error.message : String(error)
    if (nodeUrl.hostname === '127.0.0.1' || nodeUrl.hostname === 'localhost' || nodeUrl.hostname === '[::1]') {
      throw new Error(`Elasticsearch 无法连接到 ${nodeUrl.origin}：${detail}。请确认 Docker Desktop 已启动、paperagent-elasticsearch 容器正在运行，并监听该地址。`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** Minimal versioned-index writer. It stores only rebuildable BM25/search projections and vectors. */
export class ElasticsearchVectorIndex {
  constructor(private readonly config: ElasticsearchConnectionConfig) {}

  async ensureIndex(index: string, dimensions?: number): Promise<void> {
    const existing = await this.request('HEAD', `/${encodeURIComponent(index)}`)
    if (existing.status === 200) {
      // An existing index keeps its dense-vector dimension forever. Silently
      // accepting a changed provider configuration would defer the failure to
      // an opaque bulk/kNN error and could leave a paper half-indexed.
      const mapping = await this.request('GET', `/${encodeURIComponent(index)}/_mapping`)
      if (mapping.status !== 200) throw new Error(`Elasticsearch index mapping check failed: HTTP ${mapping.status}`)
      const payload: unknown = await mapping.json()
      if (dimensions !== undefined) {
        const actual = embeddingDimensions(payload, index)
        if (actual === undefined) {
          const added = await this.request('PUT', `/${encodeURIComponent(index)}/_mapping`, {
            properties: { embedding: { type: 'dense_vector', dims: dimensions, index: true, similarity: 'cosine' } },
          })
          if (added.status !== 200) throw new Error(`Elasticsearch embedding mapping update failed: HTTP ${added.status}`)
        } else if (actual !== dimensions) {
          throw new Error(`Elasticsearch index ${index} uses ${actual} embedding dimensions; configured value is ${dimensions}. Recreate the index or restore the matching embedding configuration.`)
        }
      }
      return
    }
    if (existing.status !== 404) throw new Error(`Elasticsearch index check failed: HTTP ${existing.status}`)
    const created = await this.request('PUT', `/${encodeURIComponent(index)}`, {
      mappings: { properties: {
        workspace_key: { type: 'keyword' }, library_id: { type: 'keyword' }, paper_id: { type: 'keyword' }, source_id: { type: 'keyword' }, source_kind: { type: 'keyword' },
        title: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
        section: { type: 'keyword' }, caption: { type: 'text' }, pdf_page_start: { type: 'integer' }, pdf_page_end: { type: 'integer' }, element_type: { type: 'keyword' },
        content_revision: { type: 'keyword' }, embedding_provider: { type: 'keyword' }, embedding_model: { type: 'keyword' }, content: { type: 'text' }, search_text: { type: 'text' },
        ...(dimensions === undefined ? {} : { embedding: { type: 'dense_vector', dims: dimensions, index: true, similarity: 'cosine' } }),
      } },
    })
    if (created.status !== 200 && created.status !== 201) throw new Error(`Elasticsearch index creation failed: HTTP ${created.status}`)
  }

  async upsert(index: string, documents: readonly (ElasticsearchVectorDocument & { readonly content: string })[]): Promise<void> {
    if (documents.length === 0) return
    const lines: string[] = []
    for (const document of documents) {
      lines.push(JSON.stringify({ index: { _index: index, _id: document.id } }))
      lines.push(JSON.stringify({ workspace_key: document.workspaceKey, library_id: document.libraryId, paper_id: document.paperId, source_id: document.sourceId,
        source_kind: document.sourceKind, title: document.title, section: document.section, pdf_page_start: document.pdfPageStart, pdf_page_end: document.pdfPageEnd,
        ...(document.elementType === undefined ? {} : { element_type: document.elementType }), ...(document.caption === undefined ? {} : { caption: document.caption }), content_revision: document.contentRevision,
        ...(document.embeddingProvider === undefined ? {} : { embedding_provider: document.embeddingProvider }),
        ...(document.embeddingModel === undefined ? {} : { embedding_model: document.embeddingModel }),
        ...(document.embedding === undefined ? {} : { embedding: document.embedding }), content: document.content,
        search_text: [document.title, document.section, document.caption ?? '', document.content].filter(Boolean).join('\n') }))
    }
    const response = await this.request('POST', '/_bulk', lines.join('\n') + '\n', 'application/x-ndjson')
    if (response.status < 200 || response.status >= 300) throw new Error(`Elasticsearch bulk write failed: HTTP ${response.status}`)
    const body = await response.json().catch(() => undefined) as { errors?: unknown } | undefined
    if (body?.errors === true) throw new Error('Elasticsearch bulk write reported item failures')
  }

  /**
   * Removes all derived vectors for a paper. Kept for explicit maintenance
   * tooling; rebuild workers use the safer revision-preserving method below.
   */
  async deletePaperSources(index: string, workspaceKey: string, paperId: string): Promise<void> {
    const response = await this.request('POST', `/${encodeURIComponent(index)}/_delete_by_query?conflicts=proceed&refresh=false`, {
      query: { bool: { filter: [{ term: { workspace_key: workspaceKey } }, { term: { paper_id: paperId } }] } },
    })
    if (response.status !== 200) throw new Error(`Elasticsearch paper-source deletion failed: HTTP ${response.status}`)
  }

  /** Removes only superseded revisions after a new projection is complete. */
  async deletePaperSourcesExceptRevision(index: string, workspaceKey: string, paperId: string, contentRevision: string): Promise<void> {
    const response = await this.request('POST', `/${encodeURIComponent(index)}/_delete_by_query?conflicts=proceed&refresh=false`, {
      query: { bool: {
        filter: [{ term: { workspace_key: workspaceKey } }, { term: { paper_id: paperId } }],
        must_not: [{ term: { content_revision: contentRevision } }],
      } },
    })
    if (response.status !== 200) throw new Error(`Elasticsearch stale paper-source deletion failed: HTTP ${response.status}`)
  }

  /** Keeps dynamic library classification in sync without re-embedding content. */
  async updatePaperLibrary(index: string, workspaceKey: string, paperId: string, libraryId: string | null): Promise<void> {
    await this.updatePapersLibrary(index, workspaceKey, [paperId], libraryId)
  }

  /** Batch form used when deleting a library moves many papers at once. */
  async updatePapersLibrary(index: string, workspaceKey: string, paperIds: readonly string[], libraryId: string | null): Promise<void> {
    const ids = [...new Set(paperIds)].filter(id => id.trim() !== '').slice(0, 10_000)
    if (ids.length === 0) return
    const response = await this.request('POST', `/${encodeURIComponent(index)}/_update_by_query?conflicts=proceed&refresh=false`, {
      script: { lang: 'painless', source: 'ctx._source.library_id = params.library_id', params: { library_id: libraryId } },
      query: { bool: { filter: [{ term: { workspace_key: workspaceKey } }, { terms: { paper_id: ids } }] } },
    })
    if (response.status !== 200) throw new Error(`Elasticsearch paper-library update failed: HTTP ${response.status}`)
    const body = await response.json().catch(() => undefined) as { failures?: unknown } | undefined
    if (Array.isArray(body?.failures) && body.failures.length > 0) throw new Error('Elasticsearch paper-library update reported item failures')
  }

  /**
   * Executes a workspace-scoped kNN lookup. This intentionally returns only
   * stable local identities and scores: callers must rehydrate the candidate
   * against SQLite before exposing a source to an Agent or the browser.
   */
  async searchKnn(input: ElasticsearchKnnSearchInput): Promise<readonly ElasticsearchVectorCandidate[]> {
    if (input.vector.length === 0 || input.vector.some(value => !Number.isFinite(value))) {
      throw new Error('Elasticsearch kNN query vector must contain finite values')
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 50)
    const filters = searchFilters(input)
    const response = await this.request('POST', `/${encodeURIComponent(input.index)}/_search`, {
      size: limit,
      _source: ['source_id', 'source_kind', 'paper_id'],
      knn: {
        field: 'embedding', query_vector: input.vector, k: limit,
        num_candidates: Math.min(Math.max(limit * 5, 50), 250), filter: filters,
      },
    })
    if (response.status !== 200) throw new Error(`Elasticsearch kNN search failed: HTTP ${response.status}`)
    const payload: unknown = await response.json()
    return readKnnCandidates(payload, limit)
  }

  /** Executes a workspace-scoped Elastic full-text query using BM25. */
  async searchText(input: ElasticsearchTextSearchInput): Promise<readonly ElasticsearchTextCandidate[]> {
    const query = input.query.trim()
    if (query === '') throw new Error('Elasticsearch text query must not be empty')
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 50)
    const fields = input.sourceKind === 'element'
      ? ['title^3', 'caption^2', 'section^1.5', 'search_text', 'content']
      : ['title^3', 'section^1.5', 'search_text', 'content']
    const response = await this.request('POST', `/${encodeURIComponent(input.index)}/_search`, {
      size: limit,
      _source: ['source_id', 'source_kind', 'paper_id'],
      query: { bool: {
        must: [{ multi_match: { query, fields, type: 'best_fields', operator: 'or' } }],
        filter: searchFilters(input),
      } },
      sort: [{ _score: 'desc' }, { pdf_page_start: 'asc' }],
    })
    if (response.status !== 200) throw new Error(`Elasticsearch BM25 search failed: HTTP ${response.status}`)
    const payload: unknown = await response.json()
    return readTextCandidates(payload, limit)
  }

  private async request(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<Response> {
    const target = new URL(path, normalizeElasticsearchNodeUrl(this.config.nodeUrl))
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      return await fetch(target, { method, headers: { authorization: `ApiKey ${this.config.apiKey}`, ...(body === undefined ? {} : { 'content-type': contentType }) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Elasticsearch request timed out after ${this.config.timeoutMs}ms`)
      const detail = error instanceof Error ? error.message : String(error)
      const host = target.origin
      if (target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '[::1]') {
        throw new Error(`Elasticsearch 无法连接到 ${host}：${detail}。请确认 Docker Desktop 已启动、paperagent-elasticsearch 容器正在运行，并监听该地址。`, { cause: error })
      }
      throw new Error(`Elasticsearch 请求 ${host} 失败：${detail}`, { cause: error })
    } finally { clearTimeout(timer) }
  }
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, match => `\\${match}`)
}

function searchFilters(input: Pick<ElasticsearchKnnSearchInput, 'workspaceKey' | 'libraryId' | 'paperIds' | 'section' | 'elementTypes' | 'sourceKind'>): unknown[] {
  const filters: unknown[] = [{ term: { workspace_key: input.workspaceKey } }]
  if (input.libraryId !== undefined) filters.push({ term: { library_id: input.libraryId } })
  const paperIds = [...new Set(input.paperIds ?? [])].filter(id => id.trim() !== '').slice(0, 100)
  if (paperIds.length > 0) filters.push({ terms: { paper_id: paperIds } })
  if (input.section !== undefined && input.section.trim() !== '') {
    const section = escapeWildcard(input.section.trim())
    filters.push({ bool: { should: [
      { term: { section: input.section.trim() } },
      { wildcard: { section: { value: `* > ${section}`, case_insensitive: false } } },
      { wildcard: { section: { value: `* > ${section} > *`, case_insensitive: false } } },
      { wildcard: { section: { value: `${section} > *`, case_insensitive: false } } },
    ], minimum_should_match: 1 } })
  }
  const elementTypes = [...new Set(input.elementTypes ?? [])].filter(type => type.trim() !== '').slice(0, 20)
  if (elementTypes.length > 0) filters.push({ terms: { element_type: elementTypes } })
  if (input.sourceKind !== undefined) filters.push({ term: { source_kind: input.sourceKind } })
  return filters
}

function readKnnCandidates(payload: unknown, limit: number): readonly ElasticsearchVectorCandidate[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Elasticsearch kNN search returned an invalid response')
  }
  const hits = (payload as { hits?: { hits?: unknown } }).hits?.hits
  if (!Array.isArray(hits)) throw new Error('Elasticsearch kNN search returned no hits')
  const candidates: ElasticsearchVectorCandidate[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null || Array.isArray(hit)) continue
    const row = hit as { _score?: unknown; _source?: { source_id?: unknown; source_kind?: unknown; paper_id?: unknown } }
    const source = row._source
    if (source === undefined || typeof source.source_id !== 'string' || typeof source.paper_id !== 'string'
      || (source.source_kind !== 'chunk' && source.source_kind !== 'element')
      || typeof row._score !== 'number' || !Number.isFinite(row._score)) continue
    const identity = `${source.source_kind}\u0000${source.source_id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push({ sourceId: source.source_id, sourceKind: source.source_kind, paperId: source.paper_id, score: row._score })
    if (candidates.length >= limit) break
  }
  return candidates
}

function readTextCandidates(payload: unknown, limit: number): readonly ElasticsearchTextCandidate[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Elasticsearch BM25 search returned an invalid response')
  }
  const hits = (payload as { hits?: { hits?: unknown } }).hits?.hits
  if (!Array.isArray(hits)) throw new Error('Elasticsearch BM25 search returned no hits')
  const candidates: ElasticsearchTextCandidate[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null || Array.isArray(hit)) continue
    const row = hit as { _score?: unknown; _source?: { source_id?: unknown; source_kind?: unknown; paper_id?: unknown } }
    const source = row._source
    if (source === undefined || typeof source.source_id !== 'string' || typeof source.paper_id !== 'string'
      || (source.source_kind !== 'chunk' && source.source_kind !== 'element')
      || typeof row._score !== 'number' || !Number.isFinite(row._score)) continue
    const identity = `${source.source_kind}\u0000${source.source_id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push({ sourceId: source.source_id, sourceKind: source.source_kind, paperId: source.paper_id, score: row._score })
    if (candidates.length >= limit) break
  }
  return candidates
}

function embeddingDimensions(payload: unknown, index: string): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const root = (payload as Record<string, unknown>)[index]
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined
  const mappings = (root as Record<string, unknown>).mappings
  if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) return undefined
  const properties = (mappings as Record<string, unknown>).properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return undefined
  const embedding = (properties as Record<string, unknown>).embedding
  if (typeof embedding !== 'object' || embedding === null || Array.isArray(embedding)) return undefined
  const dims = (embedding as Record<string, unknown>).dims
  return typeof dims === 'number' && Number.isSafeInteger(dims) ? dims : undefined
}
