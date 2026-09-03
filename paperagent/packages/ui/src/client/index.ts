/** PaperAgent's application-level pages and their primary sidebar navigation. */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatInlineCodeMentions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MainView, SidebarAction, type PaperAgentApi, type PaperAgentKind } from './Views.tsx'
import { citationDefinition, createCitationMentionProvider } from './Citations.tsx'
import { createRetrievalTraceDefinition, registerPaperAgentRetrievalView } from './RetrievalTrace.ts'
import { Retrieval, type RetrievalInjected } from './Retrieval.tsx'
import { PdfDrawer, PdfFullscreen, PdfPreview, type PdfOverlayInjected } from './Pdf.tsx'
import { DASHSCOPE_API_KEY_REF, ELASTICSEARCH_API_KEY_REF, MINERU_TOKEN_REF, PaperAgentSettings, type PaperAgentSettingsInjected } from './Settings.tsx'
import { PaperAgentNavigation } from './navigation.ts'
import { paperAgentRemote } from './remote.ts'

export const inject = ['slots', 'remote', 'layout', 'connection', 'conversationEvents', 'conversationViews', 'sessions', 'chatInlineCodeMentions']

/** Mount the Host BFF, then assemble primary navigation and full center pages. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(paperAgentRemote)
  const api = ctx.get('remote.paperAgent') as PaperAgentApi | undefined
  if (api === undefined) {
    await disposeRemote()
    throw new Error('PaperAgent Remote namespace did not mount')
  }

  const connection = ctx.get('connection') as ConnectionHandle
  const navigation = new PaperAgentNavigation(ctx.layout)
  const preview = new PdfPreview()
  const inlineCodeMentions = ctx.get('chatInlineCodeMentions') as ChatInlineCodeMentions
  const disposeCitationInlineProvider = inlineCodeMentions.register(createCitationMentionProvider(preview))
  const registerMainView = (kind: PaperAgentKind) => {
    const id = `paperagent/${kind}`
    const unregister = ctx.layout.registerMainView(id)
    const disposeSlot = ctx.slots.inject('shell.main', () => ctx.slots.register({
      name: 'shell.main', id, inject: () => ({ kind, api, navigation, preview }),
    }, MainView))
    return async () => { await disposeSlot(); unregister() }
  }
  const registerSidebarAction = (kind: Exclude<PaperAgentKind, 'reader'>) => ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action', id: `paperagent-${kind}`,
    inject: () => ({ kind, navigation }),
  }, SidebarAction))

  const disposePapersView = registerMainView('papers')
  // Reader is a full main view reached from citation/preview navigation; it
  // must be registered even though it has no permanent sidebar action.
  const disposeReaderView = registerMainView('reader')
  ctx.conversationEvents.register(citationDefinition)
  ctx.conversationEvents.register(createRetrievalTraceDefinition())
  registerPaperAgentRetrievalView(ctx)
  const disposeRetrievalView = ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'paperagent-retrieval',
    order: 20,
    label: '检索',
    inject: (sessionId: SessionId): RetrievalInjected => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`PaperAgent retrieval view: session "${sessionId}" is unavailable`)
      return {
        preview,
        loadOlder: async () => {
          const before = session.getSnapshot().views.get('paperagent-retrieval')
          await session.loadOlder()
          return session.getSnapshot().views.get('paperagent-retrieval') !== before
        },
      }
    },
  }, Retrieval))
  const disposePdfDrawer = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'paperagent-pdf-preview',
    inject: (): PdfOverlayInjected => ({
      api, preview,
      currentSession: () => ctx.sessions.list.getSnapshot().current,
    }),
  }, PdfDrawer))
  const disposePdfFullscreen = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'paperagent-pdf-fullscreen',
    inject: (): PdfOverlayInjected => ({
      api, preview,
      currentSession: () => ctx.sessions.list.getSnapshot().current,
    }),
  }, PdfFullscreen))
  let lastSessionId = ctx.sessions.list.getSnapshot().current
  const stopSessionReset = ctx.sessions.list.subscribe(() => {
    const nextSessionId = ctx.sessions.list.getSnapshot().current
    if (nextSessionId === lastSessionId) return
    lastSessionId = nextSessionId
    // Opening a DSH session is a chat navigation action. Keep this behavior
    // in the PaperAgent plugin so the generic workspace package stays unaware
    // of application-level main views.
    if (ctx.layout.getMainView() !== null) ctx.layout.activateMainView(null)
  })
  const stopNavigation = navigation.start()
  const disposePapersAction = registerSidebarAction('papers')
  const disposeSettingsSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'paperagent',
    order: 30,
    label: 'PaperAgent',
    inject: (): PaperAgentSettingsInjected => ({
      api: connection.api,
      paperAgentApi: api,
      currentSessionId: () => {
        const sessions = ctx.sessions.list.getSnapshot()
        return sessions.current ?? sessions.ids[0]
      },
      onCredentialUpdated: listener => ctx.remote.$on('credentials/updated', (ref) => {
        if (ref === MINERU_TOKEN_REF || ref === DASHSCOPE_API_KEY_REF || ref === ELASTICSEARCH_API_KEY_REF) listener()
      }),
    }),
  }, PaperAgentSettings))
  return async () => {
    await disposeSettingsSection()
    await disposePapersAction()
    await disposePdfFullscreen()
    await disposePdfDrawer()
    await disposeRetrievalView()
    disposeCitationInlineProvider()
    stopSessionReset()
    stopNavigation()
    
    await disposePapersView()
    await disposeReaderView()
    await disposeRemote()
  }
}
