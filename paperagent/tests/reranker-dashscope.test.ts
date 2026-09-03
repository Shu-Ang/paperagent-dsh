import assert from 'node:assert/strict'
import test from 'node:test'
import { DashScopeReranker } from '../packages/reranker-dashscope/src/index.ts'

test('DashScope text reranker uses the compatible endpoint and maps result indexes', async () => {
  let url = ''
  let request: RequestInit | undefined
  const reranker = new DashScopeReranker({
    apiKey: 'unit-test-key',
    endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/',
    model: 'qwen3-rerank',
    timeoutMs: 2_000,
    fetch: async (input, init) => {
      url = String(input)
      request = init
      return new Response(JSON.stringify({ results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.42 },
      ] }), { status: 200 })
    },
  })
  const result = await reranker.rerank({
    query: { text: 'What is the contribution?' },
    documents: [
      { sourceId: 'chunk-a', text: 'A baseline.' },
      { sourceId: 'chunk-b', text: 'The proposed contribution.' },
    ],
    topN: 2,
  })
  assert.equal(url, 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks')
  assert.deepEqual(result, [
    { sourceId: 'chunk-b', index: 1, relevanceScore: 0.91 },
    { sourceId: 'chunk-a', index: 0, relevanceScore: 0.42 },
  ])
  const payload = JSON.parse(String(request?.body)) as Record<string, unknown>
  assert.equal(payload.model, 'qwen3-rerank')
  assert.deepEqual(payload.documents, ['A baseline.', 'The proposed contribution.'])
  assert.equal((request?.headers as Record<string, string>).authorization, 'Bearer unit-test-key')
})

test('DashScope vision reranker uses native endpoint for a mixed batch', async () => {
  let url = ''
  let payload: Record<string, any> | undefined
  const reranker = new DashScopeReranker({
    apiKey: 'unit-test-key',
    endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com',
    model: 'qwen3-vl-rerank',
    timeoutMs: 2_000,
    fetch: async (input, init) => {
      url = String(input)
      payload = JSON.parse(String(init?.body)) as Record<string, any>
      return new Response(JSON.stringify({ results: [
        { index: 0, relevance_score: 0.8 },
        { index: 1, relevance_score: 0.4 },
      ] }), { status: 200 })
    },
  })
  const result = await reranker.rerank({
    query: { text: 'Which figure supports the claim?' },
    documents: [
      { sourceId: 'figure-a', text: 'Figure A', imageDataUri: 'data:image/png;base64,aGVsbG8=' },
      { sourceId: 'chunk-a', text: 'A textual explanation.' },
    ],
    topN: 2,
  })
  assert.match(url, /\/api\/v1\/services\/rerank\/text-rerank\/text-rerank$/)
  assert.equal(payload?.model, 'qwen3-vl-rerank')
  assert.deepEqual(payload?.input?.documents?.[0], { image: 'data:image/png;base64,aGVsbG8=' })
  assert.deepEqual(result.map(item => item.sourceId), ['figure-a', 'chunk-a'])
})

test('reranker rejects malformed indexes and scores', async () => {
  const reranker = new DashScopeReranker({
    apiKey: 'unit-test-key',
    endpoint: 'https://workspace.example',
    model: 'qwen3-rerank',
    timeoutMs: 2_000,
    fetch: async () => new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.5 }] }), { status: 200 }),
  })
  await assert.rejects(
    reranker.rerank({ query: { text: 'query' }, documents: [{ sourceId: 'a', text: 'document' }], topN: 1 }),
    /invalid result/,
  )
})

test('vision reranker rejects batches beyond the documented image limit before making a request', async () => {
  let called = false
  const reranker = new DashScopeReranker({
    apiKey: 'unit-test-key', endpoint: 'https://workspace.example', model: 'qwen3-vl-rerank', timeoutMs: 2_000,
    fetch: async () => { called = true; return new Response('{}', { status: 200 }) },
  })
  const documents = Array.from({ length: 41 }, (_, index) => ({
    sourceId: `figure-${index}`, text: `Figure ${index}`, imageDataUri: 'data:image/png;base64,aGVsbG8=',
  }))
  await assert.rejects(reranker.rerank({ query: { text: 'query' }, documents, topN: 6 }), /at most 40 image documents/)
  assert.equal(called, false)
})
