/** Host activation: the adapter registers, and the headless sign-in option fails loudly. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { apply, Config } from '../src/index.ts'
import type { Config as ChatGptConfig } from '../src/config.ts'

let ctx: Context | undefined
let home: string | undefined

const resolveConfig = Config as (value: unknown) => ChatGptConfig

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function boot(): Promise<{ ctx: Context; home: string }> {
  home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-apply-'))
  ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  return { ctx, home }
}

describe('ChatGPT Host activation', () => {
  it('rejects an invalid profile override set before registering the route', async () => {
    const booted = await boot()
    const config = resolveConfig({
      modelOverrides: [{ model: 'gpt-6-sol', reasoningEfforts: ['low'], defaultReasoningEffort: 'high' }],
    })
    await expect(apply(booted.ctx, config)).rejects.toThrow('outside its reasoningEfforts list')
    expect(booted.ctx.llm.listProviders()).toEqual([])
  })

  it('fails activation when authorizeOnStart cannot reach the loopback callback', async () => {
    const booted = await boot()
    const config = resolveConfig({ authorizeOnStart: true, loginTimeoutMs: 1_000, loginPollIntervalMs: 100 })
    await expect(apply(booted.ctx, config)).rejects.toThrow('ChatGPT sign-in timed out.')
    expect(booted.ctx.llm.listProviders()).toContainEqual({ id: 'chatgpt', name: 'ChatGPT' })
  })
})
