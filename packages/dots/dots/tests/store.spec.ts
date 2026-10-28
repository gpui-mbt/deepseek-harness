import { afterEach, describe, expect, it } from 'vite-plus/test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { dotsDomain } from '../src/storage.ts'
import { DotStore } from '../src/store.ts'
import { dotPaths, makeDotId } from '../src/paths.ts'
import { asDotId } from '../src/ids.ts'
import type { DotRecord } from '../src/types.ts'
import { tempRoot } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface Fixture {
  readonly root: string
  readonly store: DotStore
  readonly pool: MemoryMediaPool
}

async function fixture(pool = new MemoryMediaPool()): Promise<Fixture> {
  const temp: TempRoot = await tempRoot()
  cleanups.push(temp.cleanup)
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(dotsDomain)
  cleanups.push(async () => {
    await domain.close()
    await ctx.fiber.dispose()
  })
  return { root: temp.root, store: new DotStore(domain), pool }
}

function record(root: string, name: string, id = makeDotId(name, 'a1b2c3'), sessionId = 'sess-1'): DotRecord {
  return {
    version: 1,
    id,
    name,
    purpose: `${name} purpose`,
    directory: dotPaths(root, id).directory,
    sessionId,
    preset: 'standard',
    createdAt: 1,
    updatedAt: 1,
    assignmentCount: 0,
  }
}

describe('DotStore', () => {
  it('starts empty and round-trips records through the domain', async () => {
    const { root, store, pool } = await fixture()
    expect(store.list()).toEqual([])
    const row = record(root, 'researcher')
    await store.add(row, 4)
    expect(store.list()).toEqual([row])

    // A second context over the same medium simulates a process restart.
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const reopened = await facility.open(dotsDomain)
    cleanups.push(async () => {
      await reopened.close()
      await ctx.fiber.dispose()
    })
    expect(new DotStore(reopened).list()).toEqual([row])
  })

  it('retains quarantine records despite an occupied active name and cap', async () => {
    const { root, store } = await fixture()
    await store.add(record(root, 'same'), 1)
    const quarantine = { ...record(root, 'same', makeDotId('same', 'bbbbbb'), 'session-q'), archivedAt: 2 }
    await expect(store.add(quarantine, 1)).resolves.toEqual(quarantine)
    expect(store.list()).toHaveLength(1)
    expect(store.findBySession('session-q')).toEqual(quarantine)
  })

  it('rejects duplicate active names and the active cap', async () => {
    const { root, store } = await fixture()
    await store.add(record(root, 'one'), 2)
    await expect(store.add(record(root, 'ONE', makeDotId('one', 'ffffff'), 'sess-2'), 2)).rejects.toMatchObject({
      code: 'dots/conflict',
    })
    await store.add(record(root, 'two', makeDotId('two', 'aaaaaa'), 'sess-3'), 2)
    await expect(store.add(record(root, 'three', makeDotId('three', 'bbbbbb'), 'sess-4'), 2)).rejects.toMatchObject({
      code: 'dots/limit',
    })
  })

  it('updates and archives without losing identity', async () => {
    const { root, store } = await fixture()
    const row = record(root, 'researcher')
    await store.add(row, 4)
    const updated = await store.update(row.id, current => ({ ...current, purpose: 'new purpose', updatedAt: 2 }))
    expect(updated).toMatchObject({ id: row.id, name: row.name, purpose: 'new purpose' })
    const archived = await store.archive(row.id, 3)
    expect(archived.archivedAt).toBe(3)
    expect(store.list()).toEqual([])
    expect(store.list(true)).toHaveLength(1)
    await expect(store.archive(row.id, 4)).resolves.toMatchObject({ archivedAt: 3 })
  })

  it('refuses a mutation that changes identity or name', async () => {
    const { root, store } = await fixture()
    const row = record(root, 'researcher')
    await store.add(row, 4)
    await expect(store.update(row.id, current => ({ ...current, name: 'renamed' }))).rejects.toMatchObject({
      code: 'dots/invalid',
    })
  })

  it('rejects a reused id and reports unknown identities', async () => {
    const { root, store } = await fixture()
    const row = record(root, 'researcher')
    await store.add(row, 4)
    await expect(store.add({ ...row, name: 'other' }, 4)).rejects.toMatchObject({ code: 'dots/conflict' })
    await expect(store.update(asDotId('dot-missing-000000'), current => current)).rejects.toMatchObject({
      code: 'dots/not-found',
    })
    await expect(store.archive(asDotId('dot-missing-000000'), 1)).rejects.toMatchObject({
      code: 'dots/not-found',
    })
    await store.archive(row.id, 2)
    await expect(store.update(row.id, current => current)).rejects.toMatchObject({ code: 'dots/not-found' })
  })

  it('prefers an active record over an archived record with the same name', async () => {
    const { root, store } = await fixture()
    const first = record(root, 'same', makeDotId('same', '111111'), 'sess-1')
    await store.add(first, 4)
    await store.archive(first.id, 2)
    const second = record(root, 'same', makeDotId('same', '222222'), 'sess-2')
    await store.add(second, 4)
    expect(store.find('same')?.id).toBe(second.id)
  })

  it('resolves by id and by home session', async () => {
    const { root, store } = await fixture()
    const row = record(root, 'researcher')
    await store.add(row, 4)
    expect(store.find(row.id)?.name).toBe('researcher')
    expect(store.find('  Researcher ')?.id).toBe(row.id)
    expect(store.find('missing')).toBeUndefined()
    expect(store.findBySession('sess-1')?.id).toBe(row.id)
    expect(store.findBySession('other')).toBeUndefined()
    expect(store.list(true)[0]?.id).toBe(asDotId(row.id))
  })

  it('rejects a stored record that fails the durable checks', async () => {
    // The domain validates stored rows against the DotRecord decoder on open.
    const pool = new MemoryMediaPool()
    pool.media.set('dots', {
      tables: new Map([['dots', new Map<string, unknown>([['dot-bad', { version: 1 }]])]]),
      global: null,
    })
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    await expect(facility.open(dotsDomain)).rejects.toMatchObject({ name: 'DomainError', code: 'invalid-record' })
    await ctx.fiber.dispose()
  })
})
