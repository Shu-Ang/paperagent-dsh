import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import type { PaperAgentNavigation, PaperAgentViewMode } from './navigation.ts'
import css from './Library.module.css'

type PaperAgentKind = Exclude<PaperAgentViewMode, 'chat'>
type SidebarActionProps = PropsRuntime<'sidebar.primary.action'> & {
  readonly kind: PaperAgentKind
  readonly navigation: PaperAgentNavigation
}

/** Primary navigation entry mounted below DSH's New Session button. */
export function SidebarAction({ kind, wide, navigation }: SidebarActionProps) {
  const mode = useSyncExternalStore(navigation.subscribe, navigation.getMode)
  const active = mode === kind
  const label = kind === 'reader' ? 'PDF 预览' : '论文库'
  return (
    <button
      type="button"
      className={`${css.sidebarButton} ${active ? css.sidebarButtonActive : ''}`}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={wide ? undefined : label}
      onClick={() => { navigation.open(kind) }}
    >
      <span aria-hidden>{kind === 'reader' ? '▧' : '▤'}</span>
      {wide && <span>{label}</span>}
    </button>
  )
}
