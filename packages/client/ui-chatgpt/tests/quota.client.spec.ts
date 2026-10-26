import { describe, expect, it } from 'vite-plus/test'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session/types'
import { CHATGPT_USAGE_LIMIT_CODE, chatGptUsageLimitInWindow } from '../src/client/quota.ts'

function event<T extends SessionEventType>(
  seq: number,
  type: T,
  data: SessionEventMap[T],
): SessionEventLikeEntry {
  const entry = { type, seq: SessionSeq(seq), time: seq, data } as SessionEvent
  return { type: 'event', event: entry }
}

describe('ChatGPT usage-limit event matcher', () => {
  it('matches an exact ChatGPT quota failure after already streamed partial text', () => {
    const entries: SessionEventLikeEntry[] = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'request/header', {
        header: { config: { provider: 'chatgpt', model: 'gpt-6.1-sol' } }, reason: 'initial',
      }),
      {
        type: 'transient',
        event: {
          type: 'assistant/live-chunk', seq: 2.5, time: 2.5,
          data: {
            attemptId: LlmAttemptId('attempt-1'), turn: 1, step: 1,
            chunk: { type: 'text-delta', index: 0, text: 'partial answer' },
          },
        },
      },
      event(3, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: CHATGPT_USAGE_LIMIT_CODE, message: 'usage limit reached' } },
      }),
    ]

    expect(chatGptUsageLimitInWindow(entries)).toBe(true)
  })

  it('does not offer ChatGPT management for a known different provider', () => {
    const entries: SessionEventLikeEntry[] = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'request/header', {
        header: { config: { provider: 'other', model: 'model' } }, reason: 'initial',
      }),
      event(3, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: CHATGPT_USAGE_LIMIT_CODE, message: 'provider error' } },
      }),
    ]

    expect(chatGptUsageLimitInWindow(entries, 'chatgpt')).toBe(false)
  })

  it('uses the model-selection projection when the event window omits the request header', () => {
    const entries: SessionEventLikeEntry[] = [
      event(3, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: CHATGPT_USAGE_LIMIT_CODE, message: 'usage limit reached' } },
      }),
    ]

    expect(chatGptUsageLimitInWindow(entries, 'chatgpt')).toBe(true)
    expect(chatGptUsageLimitInWindow(entries, 'other')).toBe(false)
  })

  it('clears the visible limit after the next turn starts and succeeds', () => {
    const entries: SessionEventLikeEntry[] = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'request/header', {
        header: { config: { provider: 'chatgpt', model: 'gpt-6.1-sol' } }, reason: 'initial',
      }),
      event(3, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: CHATGPT_USAGE_LIMIT_CODE, message: 'usage limit reached' } },
      }),
      event(4, 'turn/start', { turn: 2 }),
      event(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]

    expect(chatGptUsageLimitInWindow(entries)).toBe(false)
  })
})
