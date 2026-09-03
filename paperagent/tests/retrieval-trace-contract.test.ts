import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePaperRetrievalTraceEventData } from '../packages/contracts/src/paper-retrieval-trace.ts'

function fixture() {
  return {
    version: 1,
    callId: 'call-1', turn: 4, step: 2, toolName: 'search_paper_library', totalMs: 125,
    query: { text: 'cross modal alignment', limit: 6, filters: { libraryId: 'library-a' } },
    stages: [{
      kind: 'sqlite', status: 'completed', durationMs: 3, method: 'fts',
      candidates: [{
        sourceId: 'chunk:chunk-1', paperId: 'paper-1', title: 'Paper', section: 'Method',
        pdfPageStart: 2, rank: 1, excerpt: 'bounded excerpt', sqliteRank: 1,
      }],
    }],
    warnings: [],
  }
}

test('retrieval trace decoder accepts bounded durable diagnostics', () => {
  const trace = decodePaperRetrievalTraceEventData(fixture())
  assert.equal(trace.callId, 'call-1')
  assert.ok(!('unsupported' in trace))
  assert.equal(trace.stages[0]?.candidates[0]?.excerpt, 'bounded excerpt')
})

test('retrieval trace decoder rejects unsafe candidate payloads before history replay', () => {
  const trace = fixture()
  trace.stages[0]!.candidates[0]!.excerpt = 'x'.repeat(301)
  assert.throws(() => decodePaperRetrievalTraceEventData(trace), /invalid paper retrieval trace candidate/)
})

test('retrieval trace decoder keeps a future version ignorable instead of breaking session replay', () => {
  const trace = decodePaperRetrievalTraceEventData({ version: 2, callId: 'call-future', arbitrary: 'ignored' })
  assert.deepEqual(trace, { version: 2, unsupported: true, callId: 'call-future' })
})
