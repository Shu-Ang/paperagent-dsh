/** DSH plugin entry: local paper-domain tools over a SQLite store. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import '@deepseek-ai/dsh-system-prompt'
import { registerKnownSessionEventType } from '@deepseek-ai/dsh-session'
import { decodePaperCitationsEventData, decodePaperRetrievalTraceEventData } from '@paperagent/contracts'
import { PaperAgentStore } from '@paperagent/domain'
import { PaperAgentRemoteService } from './remote.ts'
import { PaperParseJobs } from './parse-jobs.ts'
import { installPaperCitationRecorder } from './citations.ts'
import { PaperPdfAccess } from './pdf-access.ts'
import { registerPaperImportSkill } from './import/paper-import-skill.ts'
import { registerPaperResearchSkill } from './research/paper-research-skill.ts'
import { registerPaperWritingSkill } from './writing/paper-writing-skill.ts'
import { Config } from './config.ts'
import { createElasticsearchConnectionTester, createEmbeddingJobs, createMineruParser, createPaperRetriever, createVisionJobs } from './runtime.ts'
import { PAPERAGENT_EVIDENCE_POLICY } from './evidence-policy.ts'
import { registerLibraryTools } from './library-tools.ts'
import { registerElementSearchTools } from './element-search-tools.ts'
import { registerPaperImportTools } from './paper-import-tools.ts'
import { registerFigureTools } from './figure-tools.ts'
import { registerSearchTools } from './search-tools.ts'
import { registerReferenceTools } from './reference-tools.ts'
import { handleBinaryPdfUpload } from './binary-upload.ts'

export const name = 'paperagent'
export const inject = ['tools', 'systemPrompt', 'agents', 'credentials', 'webServer', 'skills']

// Register as soon as the plugin module is loaded. History endpoints may be
// queried immediately after boot, before the Cordis `apply` hook runs.
const citationEventRegistration = { decode: decodePaperCitationsEventData, retainOnDispose: true }
const earlyCitationEventRegistration = asDisposer(registerKnownSessionEventType('paperagent/citations', citationEventRegistration))
const retrievalTraceEventRegistration = { decode: decodePaperRetrievalTraceEventData, retainOnDispose: true }
const earlyRetrievalTraceEventRegistration = asDisposer(registerKnownSessionEventType('paperagent/retrieval-trace', retrievalTraceEventRegistration))

/**
 * Registers the initial local-paper tools. All tool execution derives its
 * workspace from the owning DSH session; a global paper catalog is impossible.
 */
export function apply(ctx: Context, config: Config): void {
  const storePromise = PaperAgentStore.open({ databasePath: config.databasePath, maxPdfBytes: config.maxPdfBytes })
  const retriever = createPaperRetriever(ctx, config.embedding, config.elasticsearch, config.reranker, storePromise)
  const pdfAccess = new PaperPdfAccess()
  const parser = createMineruParser(ctx, config.mineru)
  const vision = config.vision?.enabled === true ? createVisionJobs(ctx, config.vision, storePromise) : undefined
  const testElasticsearch = createElasticsearchConnectionTester(ctx, config.elasticsearch)
  const embedding = createEmbeddingJobs(ctx, config.embedding, config.elasticsearch, storePromise)
  const afterParse = async (workspace: string, paperId: string, signal?: AbortSignal): Promise<void> => {
    const store = await storePromise
    if (signal?.aborted) return
    if (vision !== undefined) {
      await vision.startQueuedForPaper(workspace, paperId)
      // Wait for visual descriptions before building vectors. Otherwise the
      // first projection permanently misses figure context.
      await vision.waitForPaper(workspace, paperId, signal)
    }
    else for (const figure of store.listPaperFigures(workspace, paperId)) {
      if (figure.visionStatus === 'queued') store.setPaperFigureVisionStatus(workspace, figure.id, 'disabled')
    }
    if (signal?.aborted) return
    await embedding?.start(workspace, paperId)
  }
  const parseJobs = new PaperParseJobs(storePromise, parser, afterParse)
  // Recover durable queued/in-flight work after a DSH restart. A recovery
  // failure must not prevent the plugin tree from loading; the corresponding
  // rows remain visible and can be retried through the normal UI/API.
  ctx.effect(async () => {
    await parseJobs.recover().catch(() => undefined)
    await vision?.recover().catch(() => undefined)
    await embedding?.recover().catch(() => undefined)
    return async () => {
      await parseJobs.stop().catch(() => undefined)
      await vision?.stop().catch(() => undefined)
      await embedding?.stop().catch(() => undefined)
      await storePromise.then(store => store.close()).catch(() => undefined)
    }
  }, 'paperagent.recover-local-jobs')
  ctx.effect(() => registerPaperImportSkill(ctx), 'paperagent.paper-import-skill')
  ctx.effect(() => registerPaperResearchSkill(ctx), 'paperagent.paper-research-skill')
  ctx.effect(() => registerPaperWritingSkill(ctx), 'paperagent.paper-writing-skill')
  installPaperCitationRecorder(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: '/api/paperagent/pdf',
    handler: async (req, res) => pdfAccess.handle(await storePromise, req, res),
  }), 'paperagent.pdf-route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/paperagent/upload', handler: async (req, res) => {
    try {
      const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId')
      const agent = sessionId === null ? undefined : ctx.agents.get(sessionId as never)
      const workspace = agent?.session.header.cwd
      if (workspace === undefined || workspace.trim() === '') throw new Error('PaperAgent requires an active workspace session')
      await handleBinaryPdfUpload(await storePromise, workspace, req, res, config.maxPdfBytes, replacePaperId => parseJobs.removePaper(workspace, replacePaperId))
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) }
  } }), 'paperagent.upload-route')
  ctx.plugin(PaperAgentRemoteService, {
    store: storePromise, maxPdfBytes: config.maxPdfBytes, downloadTimeoutMs: config.downloadTimeoutMs,
    maxDownloadRedirects: config.maxDownloadRedirects, parseJobs,
    rerankerAvailable: config.reranker?.enabled === true,
    pdfAccess, ...(vision === undefined ? {} : { vision }), ...(embedding === undefined ? {} : { embedding }), ...(testElasticsearch === undefined ? {} : { testElasticsearch }),
  })
  ctx.effect(() => {
    // Keep the type known before apply() for early history requests, then
    // release both the runtime and early registrations on plugin unload.
    const runtimeRegistration = asDisposer(registerKnownSessionEventType('paperagent/citations', citationEventRegistration))
    const traceRuntimeRegistration = asDisposer(registerKnownSessionEventType('paperagent/retrieval-trace', retrievalTraceEventRegistration))
    return () => {
      traceRuntimeRegistration()
      runtimeRegistration()
      earlyRetrievalTraceEventRegistration()
      earlyCitationEventRegistration()
    }
  }, 'paperagent.citations-event-type')
  ctx.systemPrompt.section({
    name: 'paperagent:evidence',
    order: 145,
    text: PAPERAGENT_EVIDENCE_POLICY,
  })
  registerLibraryTools(ctx, { store: storePromise })
  registerElementSearchTools(ctx, { store: storePromise, retriever })
  registerFigureTools(ctx, { store: storePromise, retriever, ...(vision === undefined ? {} : { vision }) })
  registerSearchTools(ctx, { store: storePromise, retriever })
  registerReferenceTools(ctx, { store: storePromise })
  registerPaperImportTools(ctx, {
    store: storePromise,
    parseJobs,
    parser,
    afterParse,
    maxPdfBytes: config.maxPdfBytes,
    downloadTimeoutMs: config.downloadTimeoutMs,
    maxDownloadRedirects: config.maxDownloadRedirects,
  })

}

function asDisposer(value: unknown): () => void {
  return typeof value === 'function' ? value as () => void : () => undefined
}

/** Assigns short monotonically increasing evidence aliases within one serialized tool turn. */
