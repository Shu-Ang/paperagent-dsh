import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PaperAgentNavigation, PaperAgentViewMode } from './navigation.ts'
import { Pdf, type PdfPreview } from './Pdf.tsx'
import { SidebarAction } from './SidebarAction.tsx'
import { Library } from './Library.tsx'
import type { PaperAgentApi } from './api-types.ts'
export type { PaperAgentApi } from './api-types.ts'

export type PaperAgentKind = Exclude<PaperAgentViewMode, 'chat'>
export type MainViewProps = PropsRuntime<'shell.main'> & {
  readonly kind: PaperAgentKind
  readonly api: PaperAgentApi
  readonly navigation: PaperAgentNavigation
  readonly preview: PdfPreview
}
export { SidebarAction }

/** Full-height business page selected through DSH's application main-view registry. */
export function MainView(props: MainViewProps) {
  if (props.kind === 'reader') return <Pdf {...props}/>
  return <Library {...props}/>
}
