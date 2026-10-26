/** Profile override validation for per-model ChatGPT capabilities. */
import { describe, expect, it } from 'vite-plus/test'
import { assertModelOverrides, Config } from '../src/config.ts'
import type { Config as ChatGptConfig } from '../src/config.ts'

const resolveConfig = Config as (value: unknown) => ChatGptConfig

describe('ChatGPT profile configuration', () => {
  it('accepts a consistent override set', () => {
    expect(() => {
      assertModelOverrides([
        { model: 'gpt-6-sol', contextWindow: 200_000, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
        { model: 'gpt-6-luna', contextWindow: 100_000 },
      ])
    }).not.toThrow()
  })

  it('rejects a default effort outside its own effort list', () => {
    expect(() => {
      assertModelOverrides([
        { model: 'gpt-6-sol', reasoningEfforts: ['low'], defaultReasoningEffort: 'high' },
      ])
    }).toThrow('outside its reasoningEfforts list')
  })

  it('resolves documented defaults for every optional field', () => {
    const config = resolveConfig({
      activeAccountId: 'account-1',
      modelOverrides: [{ model: 'gpt-6-sol', inputModalities: ['text'] }],
    })
    expect(config.activeAccountId.get()).toBe('account-1')
    expect(config.welcomeAcknowledged.get()).toBe(false)
    expect(config.authorizeOnStart.get()).toBe(false)
    expect(config.requestTimeoutMs.get()).toBe(10_000)
    expect(config.loginTimeoutMs.get()).toBe(300_000)
    expect(config.loginPollIntervalMs.get()).toBe(1_000)
    expect(config.streamIdleTimeoutMs.get()).toBe(120_000)
    expect(config.modelOverrides.get()).toHaveLength(1)
  })
})
