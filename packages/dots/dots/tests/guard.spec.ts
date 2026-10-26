import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { DotController } from '../src/controller.ts'
import { createToolGuard } from '../src/guard.ts'
import { DotStore } from '../src/store.ts'
import { FakeHost, memoryDomain, tempRoot, testConfig } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function setup() {
  const temp: TempRoot = await tempRoot()
  cleanups.push(temp.cleanup)
  const memory = await memoryDomain()
  cleanups.push(memory.close)
  const host = new FakeHost()
  const controller = new DotController(
    testConfig(),
    host,
    new DotStore(memory.domain),
    temp.root,
    () => undefined,
  )
  const created = await controller.create({ name: 'researcher', purpose: 'Research.' })
  return { controller, host, sessionId: created.view.sessionId }
}

/**
 * Build the slice of a tool execution the guard reads.
 * `Object.create(null)` types as `any`, so the assertion records the test
 * double without an unknown hop; the guard only reads `name` and `agent.id`.
 * @param sessionId - calling Session, or undefined for a non-agent caller.
 * @param name - tool name.
 * @returns the execution view.
 */
function execution(sessionId: string | undefined, name: string): ToolExecution {
  return Object.assign(Object.create(null), {
    name,
    ...(sessionId === undefined ? {} : { agent: { id: sessionId } }),
  }) as ToolExecution
}

describe('dot tool guard', () => {
  it('allows non-dot callers', async () => {
    const { controller } = await setup()
    const next = async () => ({ kind: 'allow' as const })
    const guard = createToolGuard(controller)
    await expect(guard(execution('main-session', 'dot_create'), next)).resolves.toEqual({ kind: 'allow' })
  })

  it('denies dot management and disallowed tools without calling next', async () => {
    const { controller, sessionId } = await setup()
    const guard = createToolGuard(controller)
    const denied = await guard(execution(sessionId, 'dot_create'), async () => ({ kind: 'allow' as const }))
    expect(denied).toMatchObject({ kind: 'deny' })
    await expect(guard(execution(sessionId, 'write'), async () => ({ kind: 'allow' as const }))).resolves.toEqual({
      kind: 'allow',
    })
  })

  it('applies exact and prefix allowlists', async () => {
    const { controller, sessionId } = await setup()
    await controller.update('researcher', { allowedTools: ['read', 'mcp__github__*'] })
    const guard = createToolGuard(controller)
    const next = async () => ({ kind: 'allow' as const })
    await expect(guard(execution(sessionId, 'read'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard(execution(sessionId, 'mcp__github__issues'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard(execution(sessionId, 'write'), next)).resolves.toMatchObject({ kind: 'deny' })
  })

  it('passes through executions without an agent', async () => {
    const { controller } = await setup()
    const guard = createToolGuard(controller)
    await expect(guard(execution(undefined, 'read'), async () => ({ kind: 'allow' as const }))).resolves.toEqual({
      kind: 'allow',
    })
  })

  it('denies dot management for a live subagent session of a dot', async () => {
    const { controller, host, sessionId } = await setup()
    host.parents.set('child-session', [sessionId])
    const guard = createToolGuard(controller)
    await expect(
      guard(execution('child-session', 'dot_archive'), async () => ({ kind: 'allow' as const })),
    ).resolves.toMatchObject({ kind: 'deny' })
  })

  it('stops denying after the dot is archived', async () => {
    const { controller, sessionId } = await setup()
    await controller.archive('researcher')
    const guard = createToolGuard(controller)
    await expect(guard(execution(sessionId, 'dot_create'), async () => ({ kind: 'allow' as const }))).resolves.toEqual({
      kind: 'allow',
    })
  })

})
