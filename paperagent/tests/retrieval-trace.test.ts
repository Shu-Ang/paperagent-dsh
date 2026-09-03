import assert from 'node:assert/strict'
import test from 'node:test'
import { PaperRetrievalTraceCollector } from '../packages/tools/src/retrieval-trace.ts'

test('retrieval trace persists one bounded diagnostic against the active tool call', () => {
  const appended: Array<{ type: string; data: unknown }> = []
  const session = {
    events: [{ type: 'tool/call', data: { callId: 'call-1', turn: 3, step: 2 } }],
    append(type: string, data: unknown) { appended.push({ type, data }) },
  }
  const collector = new PaperRetrievalTraceCollector()
  collector.stage({
    kind: 'sqlite', status: 'completed', durationMs: 4, method: 'fts',
    candidates: [{
      sourceId: 'chunk-1', paperId: 'paper-1', title: 'Paper', section: 'Method', pdfPageStart: 2,
      rank: 1, excerpt: 'Bearer secret-must-not-appear',
    }],
  })
  collector.record({ callId: 'call-1', agent: { session } } as never, {
    toolName: 'search_paper_library', query: 'alignment', limit: 6, filters: { libraryId: 'library-1' },
  })

  assert.equal(appended.length, 1)
  assert.equal(appended[0]?.type, 'paperagent/retrieval-trace')
  assert.deepEqual(appended[0]?.data, {
    version: 1, callId: 'call-1', turn: 3, step: 2, toolName: 'search_paper_library',
    totalMs: (appended[0]?.data as { totalMs: number }).totalMs,
    query: { text: 'alignment', limit: 6, filters: { libraryId: 'library-1' } },
    stages: [{
      kind: 'sqlite', status: 'completed', durationMs: 4, method: 'fts',
      candidates: [{
        sourceId: 'chunk-1', paperId: 'paper-1', title: 'Paper', section: 'Method', pdfPageStart: 2,
        rank: 1, excerpt: 'Bearer [redacted]',
      }],
    }],
    warnings: [],
  })
})

test('retrieval trace does not append when the call is absent from the durable session', () => {
  const appended: unknown[] = []
  const collector = new PaperRetrievalTraceCollector()
  collector.record({ callId: 'missing', agent: { session: { events: [], append: (...args: unknown[]) => appended.push(args) } } } as never, {
    toolName: 'search_paper_figures', query: 'chart', limit: 6, filters: {},
  })
  assert.deepEqual(appended, [])
})
