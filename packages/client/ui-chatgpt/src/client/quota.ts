/** ChatGPT usage-limit recognition from public Session event and projection faces. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionEventChange, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'

/** Exact OpenAI SIWC code for a plan sharing usage limit. */
export const CHATGPT_USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded'

/** Whether the latest completed turn failed on a ChatGPT plan usage limit. */
export interface ChatGptUsageLimitSnapshot {
  readonly active: boolean
}

/** Per-Session request and finish facts needed to recognize the latest quota error. */
export interface ChatGptUsageCursor {
  readonly requestProvider: string | undefined
  readonly failureCode: string | undefined
  readonly failureProvider: string | undefined
}

/** Empty state for the first event in one Session window. */
export const EMPTY_CHATGPT_USAGE_CURSOR: ChatGptUsageCursor = {
  requestProvider: undefined,
  failureCode: undefined,
  failureProvider: undefined,
}

/** Fold one public Session event into the quota matcher. Transient stream chunks leave it unchanged.
 * @param cursor - current request and failure facts.
 * @param entry - next public Session entry.
 * @returns the updated facts for this turn.
 */
export function advanceChatGptUsageCursor(
  cursor: ChatGptUsageCursor,
  entry: SessionEventLikeEntry,
): ChatGptUsageCursor {
  if (entry.type !== 'event') return cursor
  const { event } = entry
  if (event.type === 'turn/start') {
    return { requestProvider: undefined, failureCode: undefined, failureProvider: undefined }
  }
  if (event.type === 'request/header') {
    return { ...cursor, requestProvider: event.data.header.config.provider }
  }
  if (event.type !== 'turn/end') return cursor
  const failure = event.data.reason.kind === 'error' ? event.data.reason.error : undefined
  return {
    requestProvider: undefined,
    failureCode: failure?.code,
    failureProvider: cursor.requestProvider,
  }
}

/** Whether a folded finish is the SIWC usage limit for ChatGPT when provider data is available.
 * @param cursor - request and finish facts from the current event window.
 * @param projectedProvider - last-used provider when the request header is absent.
 * @returns whether Manage usage should be offered for this failure.
 */
export function isChatGptUsageLimit(cursor: ChatGptUsageCursor, projectedProvider?: string): boolean {
  const provider = cursor.failureProvider ?? projectedProvider
  return cursor.failureCode === CHATGPT_USAGE_LIMIT_CODE
    && (provider === undefined || provider === 'chatgpt')
}

/** Fold one current Session window for the keyless quota-event tests.
 * @param entries - public Session event entries in sequence order.
 * @param projectedProvider - last-used provider when the request header is absent.
 * @returns whether the latest finished turn is a ChatGPT usage-limit failure.
 */
export function chatGptUsageLimitInWindow(
  entries: readonly SessionEventLikeEntry[],
  projectedProvider?: string,
): boolean {
  return isChatGptUsageLimit(entries.reduce(advanceChatGptUsageCursor, EMPTY_CHATGPT_USAGE_CURSOR), projectedProvider)
}

function projectedLastUsedProvider(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('lastUsed' in value)) return undefined
  const lastUsed = value.lastUsed
  if (typeof lastUsed !== 'object' || lastUsed === null || !('provider' in lastUsed)) return undefined
  return typeof lastUsed.provider === 'string' ? lastUsed.provider : undefined
}

/** The two public faces one usage notice reads from a Session binding. */
export interface ChatGptUsageLimitBinding {
  readonly session: {
    readonly projections: {
      faceOf(key: 'modelSelection'): {
        getSnapshot(): unknown
        subscribe(listener: () => void): () => void
      }
    }
  }
  readonly eventSource: {
    getSnapshot(): {
      readonly entries: readonly SessionEventLikeEntry[]
      readonly change: SessionEventChange
    }
    subscribe(listener: () => void): () => void
  }
}

/** Observe one Session's current ChatGPT plan-limit failure. */
export class ChatGptUsageLimitSource implements ObservableSnapshot<ChatGptUsageLimitSnapshot> {
  private snapshot: ChatGptUsageLimitSnapshot = { active: false }
  private readonly listeners = new Set<() => void>()
  private cursor = EMPTY_CHATGPT_USAGE_CURSOR
  private readonly stopEvents: () => void
  private readonly stopSelection: () => void

  /** @param binding - the public Session binding whose events own this notice. */
  constructor(binding: ChatGptUsageLimitBinding) {
    const selection = binding.session.projections.faceOf('modelSelection')
    const refresh = (): void => {
      this.publish(projectedLastUsedProvider(selection.getSnapshot()))
    }
    this.stopSelection = selection.subscribe(refresh)
    this.replay(binding.eventSource.getSnapshot().entries, projectedLastUsedProvider(selection.getSnapshot()))
    this.stopEvents = binding.eventSource.subscribe(() => {
      const { change } = binding.eventSource.getSnapshot()
      if (change.kind === 'replace') {
        this.cursor = EMPTY_CHATGPT_USAGE_CURSOR
        this.replay(change.entries, projectedLastUsedProvider(selection.getSnapshot()))
      } else if (change.kind === 'append') {
        this.applyEntries(change.entries, projectedLastUsedProvider(selection.getSnapshot()))
      }
    })
  }

  /** @returns the current notice state. */
  getSnapshot(): ChatGptUsageLimitSnapshot {
    return this.snapshot
  }

  /** Subscribe to changes in the usage-limit notice.
   * @param listener - called when the notice state changes.
   * @returns the unsubscribe callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stop the Session event and projection subscriptions. */
  dispose(): void {
    this.stopEvents()
    this.stopSelection()
    this.listeners.clear()
  }

  private replay(entries: readonly SessionEventLikeEntry[], projectedProvider: string | undefined): void {
    this.cursor = entries.reduce(advanceChatGptUsageCursor, EMPTY_CHATGPT_USAGE_CURSOR)
    this.publish(projectedProvider)
  }

  private applyEntries(entries: readonly SessionEventLikeEntry[], projectedProvider: string | undefined): void {
    for (const entry of entries) this.cursor = advanceChatGptUsageCursor(this.cursor, entry)
    this.publish(projectedProvider)
  }

  private publish(projectedProvider?: string): void {
    const active = isChatGptUsageLimit(this.cursor, projectedProvider)
    if (this.snapshot.active === active) return
    this.snapshot = { active }
    for (const listener of this.listeners) listener()
  }
}
