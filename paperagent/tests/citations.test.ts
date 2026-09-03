import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PaperAgentStore } from '../packages/domain/src/index.ts'
import { installPaperCitationRecorder, paperCitationPresentationMeta } from '../packages/tools/src/citations.ts'

test('records only current-turn citations actually returned by a PaperAgent tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paperagent-citations-'))
  const workspace = join(root, 'workspace')
  const source = join(root, 'paper.pdf')
  const store = await PaperAgentStore.open({ databasePath: join(root, 'domain.sqlite'), maxPdfBytes: 1024 * 1024 })
  try {
    await mkdir(workspace)
    await writeFile(source, '%PDF-1.4\nexample')
    const paper = await store.importPaper({ workspacePath: workspace, sourcePath: source, title: 'Evidence Paper' })
    let listener: ((session: any, event: any) => void) | undefined
    let options: { global?: boolean } | undefined
    installPaperCitationRecorder({
      on: (_name: string, callback: typeof listener, value: { global?: boolean }) => {
      listener = callback
      options = value
      },
      logger: { warn: () => undefined },
    } as any)
    if (listener === undefined) assert.fail('expected a session-event listener')
    assert.equal(options?.global, true)
    const valid = {
      citationId: 'chunk-1', paperId: paper.paper.id, title: 'Evidence Paper', section: 'Introduction',
      pdfPageStart: 1, pdfPageEnd: 1, markdownLineStart: 1, markdownLineEnd: 2, excerpt: 'verified evidence',
    }
    const appended: Array<{ type: string; data: unknown }> = []
    const session = {
      header: { cwd: workspace },
      events: [{ type: 'tool/result', data: { turn: 7, meta: paperCitationPresentationMeta([{ evidenceId: 'E_chunk-1', citation: valid }]) } }],
      append: (type: string, data: unknown) => appended.push({ type, data }),
    }
    listener(session, {
      type: 'assistant/message', seq: 42,
      data: { turn: 7, message: { id: 'assistant-1', content: [{ type: 'text', text: 'Verified `paperagent-cite:E_chunk-1`, bare paperagent-cite:E_chunk-1, and `paperagent-cite:E_forged`.' }] } },
    })
    await new Promise<void>(resolve => queueMicrotask(resolve))
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.type, 'paperagent/citations')
    const data = appended[0]?.data as { citations: Array<{ citationId: string }>; references: Array<{ evidenceId: string; ordinal: number; markerStart: number; markerEnd: number }> }
    assert.deepEqual(data.citations.map(citation => citation.citationId), ['chunk-1'])
    assert.deepEqual(data.references.map(reference => [reference.evidenceId, reference.ordinal]), [['E_chunk-1', 1], ['E_chunk-1', 1]])
    const firstReference = data.references[0]
    assert.ok(firstReference)
    assert.equal(firstReference.markerEnd > firstReference.markerStart, true)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
