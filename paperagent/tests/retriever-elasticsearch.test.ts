import assert from 'node:assert/strict'
import test from 'node:test'
import { ElasticsearchVectorIndex } from '../packages/retriever-elasticsearch/src/index.ts'

test('kNN requests carry every local ownership and structured filter to Elasticsearch', async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  await withFetch(async (input, init) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
    return json({ hits: { hits: [{
      _score: 0.92,
      _source: { source_id: 'element:element-1', source_kind: 'element', paper_id: 'paper-1' },
    }] } })
  }, async () => {
    const index = new ElasticsearchVectorIndex({ nodeUrl: 'http://127.0.0.1:9200', apiKey: 'not-a-real-key', timeoutMs: 1_000 })
    const candidates = await index.searchKnn({
      index: 'paperagent-elements-v1', vector: [0.1, 0.2], workspaceKey: 'workspace-hash', limit: 6,
      libraryId: 'library-1', paperIds: ['paper-1', 'paper-2'], section: 'Experiments',
      elementTypes: ['table', 'figure'], sourceKind: 'element',
    })
    assert.deepEqual(candidates, [{ sourceId: 'element:element-1', sourceKind: 'element', paperId: 'paper-1', score: 0.92 }])
  })

  assert.match(requests[0]?.url ?? '', /paperagent-elements-v1\/_search$/)
  const body = JSON.parse(String(requests[0]?.init?.body)) as { knn: { filter: readonly unknown[] } }
  assert.deepEqual(body.knn.filter, [
    { term: { workspace_key: 'workspace-hash' } },
    { term: { library_id: 'library-1' } },
    { terms: { paper_id: ['paper-1', 'paper-2'] } },
    { bool: { minimum_should_match: 1, should: [
      { term: { section: 'Experiments' } },
      { wildcard: { section: { value: '* > Experiments', case_insensitive: false } } },
      { wildcard: { section: { value: '* > Experiments > *', case_insensitive: false } } },
      { wildcard: { section: { value: 'Experiments > *', case_insensitive: false } } },
    ] } },
    { terms: { element_type: ['table', 'figure'] } },
    { term: { source_kind: 'element' } },
  ])
})

test('paper rebuild deletes stale derived vectors only within its workspace and paper', async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  await withFetch(async (input, init) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
    return json({ deleted: 3 })
  }, async () => {
    const index = new ElasticsearchVectorIndex({ nodeUrl: 'http://127.0.0.1:9200', apiKey: 'not-a-real-key', timeoutMs: 1_000 })
    await index.deletePaperSources('paperagent-chunks-v1', 'workspace-hash', 'paper-1')
  })

  assert.match(requests[0]?.url ?? '', /paperagent-chunks-v1\/_delete_by_query\?conflicts=proceed&refresh=false$/)
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    query: { bool: { filter: [{ term: { workspace_key: 'workspace-hash' } }, { term: { paper_id: 'paper-1' } }] } },
  })
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function withFetch(
  implementation: typeof fetch,
  callback: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch
  globalThis.fetch = implementation
  try {
    await callback()
  } finally {
    globalThis.fetch = previous
  }
}
