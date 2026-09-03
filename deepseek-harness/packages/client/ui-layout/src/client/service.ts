/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Register an application-level main view id and return its unload disposer. */
  registerMainView(id: string): () => void
  /** Switch the center workspace to a registered main view, or `null` for Chat. */
  activateMainView(id: string | null): boolean
  /** Return the active application-level view; `null` is the built-in Chat surface. */
  getMainView(): string | null
  /** Subscribe to application-level main-view changes. */
  subscribeMainView(listener: () => void): () => void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #mainViews = new Set<string>()
  #activeMainView: string | null = null
  #mainViewListeners = new Set<() => void>()

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  registerMainView(id: string): () => void {
    if (id.length === 0) throw new Error('layout: main view id must not be empty')
    if (this.#mainViews.has(id)) throw new Error(`layout: main view "${id}" is already registered`)
    this.#mainViews.add(id)
    return () => {
      this.#mainViews.delete(id)
      if (this.#activeMainView === id) {
        this.#activeMainView = null
        this.#emitMainViewChange()
      }
    }
  }

  activateMainView(id: string | null): boolean {
    if (id !== null && !this.#mainViews.has(id)) return false
    if (this.#activeMainView === id) return true
    this.#activeMainView = id
    this.#emitMainViewChange()
    return true
  }

  getMainView(): string | null {
    return this.#activeMainView
  }

  subscribeMainView(listener: () => void): () => void {
    this.#mainViewListeners.add(listener)
    return () => { this.#mainViewListeners.delete(listener) }
  }

  #emitMainViewChange(): void {
    for (const listener of this.#mainViewListeners) listener()
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
