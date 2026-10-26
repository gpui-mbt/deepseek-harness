// @vitest-environment jsdom
/** ChatGPT usage-limit recognition from public Session event and projection faces. */
import { describe, expect, it, vi } from 'vite-plus/test'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEventChange, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatGptUsageLimitBinding } from '../src/client/quota.ts'
import {
  advanceChatGptUsageCursor,
  CHATGPT_USAGE_LIMIT_CODE,
  ChatGptUsageLimitSource,
  chatGptUsageLimitInWindow,
  EMPTY_CHATGPT_USAGE_CURSOR,
  isChatGptUsageLimit,
} from '../src/client/quota.ts'

function event<T extends SessionEvent['type']>(
  seq: number,
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq: SessionSeq(seq), time: seq, data } as SessionEvent }
}

function selection(provider: string | undefined) {
  const listeners = new Set<() => void>()
  let snapshot: unknown = { lastUsed: provider === undefined ? null : { provider, model: 'gpt-model' } }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: () => { for (const listener of listeners) listener() },
    set(next: unknown) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function bindingFixture(provider: string | undefined, entries: readonly SessionEventLikeEntry[]) {
  const selectionFace = selection(provider)
  let snapshot: {
    entries: readonly SessionEventLikeEntry[]
    change: SessionEventChange
  } = {
    entries: [...entries],
    change: { kind: 'replace', entries: [...entries] },
  }
  const listeners = new Set<() => void>()
  const binding: ChatGptUsageLimitBinding = {
    session: { projections: { faceOf: () => selectionFace } },
    eventSource: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
  return {
    binding,
    selectionFace,
    replace(next: readonly SessionEventLikeEntry[]) {
      snapshot = { entries: [...next], change: { kind: 'replace', entries: [...next] } }
      for (const listener of listeners) listener()
    },
    append(next: readonly SessionEventLikeEntry[]) {
      snapshot = { entries: [...snapshot.entries, ...next], change: { kind: 'append', entries: [...next] } }
      for (const listener of listeners) listener()
    },
    prepend(next: readonly SessionEventLikeEntry[]) {
      snapshot = { entries: [...next, ...snapshot.entries], change: { kind: 'prepend', entries: [...next] } }
      for (const listener of listeners) listener()
    },
  }
}

const header = (seq: number, provider: string): SessionEventLikeEntry =>
  event(seq, 'request/header', { header: { config: { provider, model: 'gpt-model' } }, reason: 'initial' })

const failure = (seq: number, code: string): SessionEventLikeEntry =>
  event(seq, 'turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { code, message: 'refused' } },
  })

const success = (seq: number): SessionEventLikeEntry =>
  event(seq, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

describe('ChatGPT usage-limit event matcher', () => {
  it('ignores transient chunks and unrelated Session events', () => {
    const transient: SessionEventLikeEntry = {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk', seq: SessionSeq(1), time: 1,
        data: {
          attemptId: LlmAttemptId('attempt-1'), turn: 1, step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'partial' },
        },
      },
    }
    expect(advanceChatGptUsageCursor(EMPTY_CHATGPT_USAGE_CURSOR, transient)).toBe(EMPTY_CHATGPT_USAGE_CURSOR)
    const start = event(1, 'turn/start', { turn: 1 })
    expect(advanceChatGptUsageCursor({ requestProvider: 'chatgpt', failureCode: 'x', failureProvider: 'y' }, start))
      .toEqual(EMPTY_CHATGPT_USAGE_CURSOR)
    expect(advanceChatGptUsageCursor(EMPTY_CHATGPT_USAGE_CURSOR, success(2))).toEqual({
      requestProvider: undefined,
      failureCode: undefined,
      failureProvider: undefined,
    })
  })

  it('recognizes the exact SIWC code only for a ChatGPT request', () => {
    const entries = [header(1, 'chatgpt'), failure(2, CHATGPT_USAGE_LIMIT_CODE)]
    expect(chatGptUsageLimitInWindow(entries)).toBe(true)
    expect(chatGptUsageLimitInWindow([header(1, 'deepseek'), failure(2, CHATGPT_USAGE_LIMIT_CODE)])).toBe(false)
    expect(chatGptUsageLimitInWindow([header(1, 'chatgpt'), failure(2, 'rate_limit')])).toBe(false)
    expect(chatGptUsageLimitInWindow([header(1, 'chatgpt'), success(2)])).toBe(false)
  })

  it('falls back to the projected provider when the turn sent no request header', () => {
    const entries = [failure(1, CHATGPT_USAGE_LIMIT_CODE)]
    expect(chatGptUsageLimitInWindow(entries, 'chatgpt')).toBe(true)
    expect(chatGptUsageLimitInWindow(entries, 'deepseek')).toBe(false)
    expect(chatGptUsageLimitInWindow(entries)).toBe(true)
    expect(isChatGptUsageLimit({ ...EMPTY_CHATGPT_USAGE_CURSOR, failureCode: CHATGPT_USAGE_LIMIT_CODE }, 'other'))
      .toBe(false)
  })
})

describe('ChatGptUsageLimitSource', () => {
  it('replays the current window and publishes changes once per state', () => {
    const fixture = bindingFixture('chatgpt', [header(1, 'chatgpt'), failure(2, CHATGPT_USAGE_LIMIT_CODE)])
    const source = new ChatGptUsageLimitSource(fixture.binding)
    const listener = vi.fn()
    const stop = source.subscribe(listener)

    expect(source.getSnapshot()).toEqual({ active: true })
    fixture.append([failure(3, 'rate_limit')])
    expect(source.getSnapshot()).toEqual({ active: false })
    // A repeated non-quota failure does not notify again.
    fixture.append([failure(4, 'rate_limit')])
    expect(listener).toHaveBeenCalledTimes(1)

    stop()
    fixture.append([failure(5, CHATGPT_USAGE_LIMIT_CODE)])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toEqual({ active: true })
    source.dispose()
  })

  it('ignores prepended history and projection values that carry no provider', () => {
    const fixture = bindingFixture(undefined, [])
    const source = new ChatGptUsageLimitSource(fixture.binding)
    expect(source.getSnapshot()).toEqual({ active: false })

    fixture.selectionFace.set({ lastUsed: null })
    expect(source.getSnapshot()).toEqual({ active: false })
    fixture.selectionFace.set({ lastUsed: { provider: 42 } })
    expect(source.getSnapshot()).toEqual({ active: false })
    fixture.selectionFace.set(null)
    expect(source.getSnapshot()).toEqual({ active: false })

    fixture.prepend([header(1, 'chatgpt'), failure(2, CHATGPT_USAGE_LIMIT_CODE)])
    expect(source.getSnapshot()).toEqual({ active: false })
    source.dispose()
  })

  it('keeps a non-turn-end message event from moving the cursor', () => {
    const cursor = { requestProvider: 'chatgpt', failureCode: 'x', failureProvider: 'chatgpt' }
    const message = event(1, 'step/start', { turn: 1, step: 1 })
    expect(advanceChatGptUsageCursor(cursor, message)).toBe(cursor)
  })

  it('resets on a replace and follows the model-selection projection', () => {
    const fixture = bindingFixture(undefined, [failure(1, CHATGPT_USAGE_LIMIT_CODE)])
    const source = new ChatGptUsageLimitSource(fixture.binding)
    expect(source.getSnapshot()).toEqual({ active: true })

    fixture.selectionFace.notify()
    expect(source.getSnapshot()).toEqual({ active: true })

    fixture.replace([])
    expect(source.getSnapshot()).toEqual({ active: false })

    fixture.replace([failure(2, CHATGPT_USAGE_LIMIT_CODE)])
    expect(source.getSnapshot()).toEqual({ active: true })
    source.dispose()
  })
})
