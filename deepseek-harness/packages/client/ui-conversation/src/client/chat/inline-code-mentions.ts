/** Shared registry for optional settled-assistant inline-code actions. */

import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTailOwnerProps } from '../contract/slots.ts'

/** An optional feature's exact-token resolver for one finalized assistant answer. */
export interface ChatInlineCodeMentionProvider {
  forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined
}

/** Composes independently owned inline-code token vocabularies without token guessing. */
export class ChatInlineCodeMentions {
  private readonly providers = new Set<ChatInlineCodeMentionProvider>()

  register(provider: ChatInlineCodeMentionProvider): () => void {
    this.providers.add(provider)
    return () => { this.providers.delete(provider) }
  }

  forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined {
    const resolvers = [...this.providers]
      .map(provider => provider.forClosing(owner))
      .filter((value): value is MarkdownFileMentions => value !== undefined)
    return combineMarkdownFileMentions(resolvers)
  }
}

/** Combines owned token vocabularies in registration order; the first exact match wins. */
export function combineMarkdownFileMentions(resolvers: readonly MarkdownFileMentions[]): MarkdownFileMentions | undefined {
  if (resolvers.length === 0) return undefined
  return {
    resolve(value) {
      for (const resolver of resolvers) {
        const mention = resolver.resolve(value)
        if (mention !== undefined) return mention
      }
      return undefined
    },
    resolveText(value) {
      const candidates: Array<{ start: number; end: number; mention: NonNullable<ReturnType<MarkdownFileMentions['resolve']>>; provider: number }> = []
      for (const [provider, resolver] of resolvers.entries()) {
        for (const item of resolver.resolveText?.(value) ?? []) {
          candidates.push({ ...item, provider })
        }
      }
      if (candidates.length === 0) return []
      candidates.sort((left, right) => left.start - right.start || left.provider - right.provider || left.end - right.end)
      const accepted: typeof candidates = []
      let end = 0
      for (const item of candidates) {
        if (item.start < end) continue
        accepted.push(item)
        end = item.end
      }
      return accepted.map(({ start, end: itemEnd, mention }) => ({ start, end: itemEnd, mention }))
    },
  }
}
