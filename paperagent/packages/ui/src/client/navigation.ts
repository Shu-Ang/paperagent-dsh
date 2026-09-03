import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

export type PaperAgentViewMode = 'chat' | 'papers' | 'reader'

export interface PaperReaderTarget {
  readonly paperId: string
  readonly page: number
}

const VIEW_ID: Record<Exclude<PaperAgentViewMode, 'chat'>, string> = {
  papers: 'paperagent/papers',
  reader: 'paperagent/reader',
}

function modeFromLocation(): PaperAgentViewMode {
  const view = new URLSearchParams(window.location.search).get('view')
  return view === 'papers' || view === 'reader' ? view : 'chat'
}

/** Keeps PaperAgent's URL state and DSH's generic main-view registry in sync. */
export class PaperAgentNavigation {
  #mode: PaperAgentViewMode = 'chat'
  #listeners = new Set<() => void>()
  #offLayout: (() => void) | undefined
  #onPopState = () => {
    this.#apply(modeFromLocation(), false)
    for (const listener of this.#listeners) listener()
  }

  constructor(private readonly layout: ILayout) {}

  start(): () => void {
    this.#offLayout = this.layout.subscribeMainView(() => {
      const active = this.layout.getMainView()
      const expected = this.#mode === 'chat' ? null : VIEW_ID[this.#mode]
      if (active !== expected) this.#apply('chat', true)
    })
    window.addEventListener('popstate', this.#onPopState)
    this.#apply(modeFromLocation(), false)
    return () => {
      window.removeEventListener('popstate', this.#onPopState)
      this.#offLayout?.()
    }
  }

  getMode = (): PaperAgentViewMode => this.#mode

  getReaderTarget = (): PaperReaderTarget | undefined => {
    if (this.#mode !== 'reader') return undefined
    const params = new URLSearchParams(window.location.search)
    const paperId = params.get('paper')
    const page = Number(params.get('page'))
    if (paperId === null || paperId.trim() === '' || !Number.isSafeInteger(page) || page < 1) return undefined
    return { paperId, page }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  open(mode: PaperAgentViewMode): void {
    this.#writeUrl(mode, false)
    this.#apply(mode, false)
  }

  openReader(paperId: string, page = 1): void {
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'reader')
    url.searchParams.set('paper', paperId)
    url.searchParams.set('page', String(safePage))
    window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    this.#apply('reader', false)
  }

  #apply(mode: PaperAgentViewMode, replaceInvalidUrl: boolean): void {
    const requestedView = mode === 'chat' ? null : VIEW_ID[mode]
    // Set the plugin mode before changing DSH's registry: activateMainView()
    // synchronously notifies listeners, which must observe the matching mode.
    this.#setMode(mode)
    if (requestedView === null) {
      this.layout.activateMainView(null)
      return
    }
    if (this.layout.activateMainView(requestedView)) return
    if (replaceInvalidUrl) this.#writeUrl('chat', true)
    this.#setMode('chat')
    this.layout.activateMainView(null)
  }

  #setMode(mode: PaperAgentViewMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    for (const listener of this.#listeners) listener()
  }

  #writeUrl(mode: PaperAgentViewMode, replace: boolean): void {
    const url = new URL(window.location.href)
    if (mode === 'chat') url.searchParams.delete('view')
    else url.searchParams.set('view', mode)
    if (mode !== 'reader') {
      url.searchParams.delete('paper')
      url.searchParams.delete('page')
    }
    const next = `${url.pathname}${url.search}${url.hash}`
    if (replace) window.history.replaceState(window.history.state, '', next)
    else window.history.pushState(window.history.state, '', next)
  }
}
