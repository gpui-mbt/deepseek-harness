import { afterEach, describe, expect, it } from 'vite-plus/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DotStore } from '../src/store.ts'
import { importLegacyRegistry } from '../src/legacy.ts'
import { makeDotId } from '../src/paths.ts'
import type { DotRecord } from '../src/types.ts'
import { memoryDomain } from './helpers.ts'
import type { MemoryDomain } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface Fixture {
  readonly root: string
  readonly file: string
  readonly memory: MemoryDomain
  readonly store: DotStore
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dots-legacy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const memory = await memoryDomain()
  cleanups.push(memory.close)
  return { root, file: join(root, 'registry.json'), memory, store: new DotStore(memory.domain) }
}

function record(root: string, name: string, sessionId = 'sess-1'): DotRecord {
  const id = makeDotId(name, 'a1b2c3')
  return {
    version: 1,
    id,
    name,
    purpose: `${name} purpose`,
    directory: join(root, id),
    sessionId,
    preset: 'standard',
    createdAt: 1,
    updatedAt: 1,
    assignmentCount: 0,
  }
}

describe('legacy registry import', () => {
  it('does nothing when the file is absent', async () => {
    const { file, memory } = await fixture()
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).resolves.toEqual({
      imported: 0,
      leftInPlace: false,
    })
  })

  it('imports every record once and renames the file', async () => {
    const { root, file, memory, store } = await fixture()
    const records = [record(root, 'researcher'), record(root, 'writer', 'sess-2')]
    await writeFile(file, JSON.stringify({ version: 1, dots: records }), 'utf8')
    const result = await importLegacyRegistry(memory.domain.table('dots'), file)
    expect(result).toEqual({ imported: 2, leftInPlace: false })
    expect(store.list(true)).toEqual(records)
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(`${file}.imported`, 'utf8'))).toMatchObject({ version: 1 })

    // A second activation finds neither a file nor an empty table to import.
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).resolves.toEqual({
      imported: 0,
      leftInPlace: false,
    })
  })

  it('leaves a file in place when the table already holds records', async () => {
    const { root, file, memory, store } = await fixture()
    await store.add(record(root, 'existing'), 4)
    await writeFile(file, JSON.stringify({ version: 1, dots: [record(root, 'legacy', 'sess-9')] }), 'utf8')
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).resolves.toEqual({
      imported: 0,
      leftInPlace: true,
    })
    expect(store.list(true).map(item => item.name)).toEqual(['existing'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('refuses invalid JSON instead of overwriting it', async () => {
    const { file, memory, store } = await fixture()
    await writeFile(file, '{not json', 'utf8')
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).rejects.toMatchObject({
      code: 'dots/registry-corrupt',
    })
    expect(store.list(true)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('{not json')
  })

  it('refuses a document with an invalid record', async () => {
    const { root, file, memory, store } = await fixture()
    const broken = { ...record(root, 'broken'), sessionId: '' }
    await writeFile(file, JSON.stringify({ version: 1, dots: [broken] }), 'utf8')
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).rejects.toMatchObject({
      code: 'dots/registry-corrupt',
    })
    expect(store.list(true)).toEqual([])
  })

  it('refuses duplicate active names already present on disk', async () => {
    const { root, file, memory } = await fixture()
    const first = record(root, 'same', 'sess-1')
    const second = { ...record(root, 'Same', 'sess-2'), id: makeDotId('same', '222222'), directory: join(root, 'x') }
    await writeFile(file, JSON.stringify({ version: 1, dots: [first, second] }), 'utf8')
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).rejects.toMatchObject({
      code: 'dots/registry-corrupt',
    })
  })

  it('reports an unreadable path and a failed rename', async () => {
    const { root, file, memory } = await fixture()
    await expect(importLegacyRegistry(memory.domain.table('dots'), root)).rejects.toMatchObject({
      code: 'dots/unavailable',
    })

    await writeFile(file, JSON.stringify({ version: 1, dots: [record(root, 'researcher')] }), 'utf8')
    // An existing directory at the target name makes the rename fail.
    await mkdir(`${file}.imported`)
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).rejects.toMatchObject({
      code: 'dots/unavailable',
    })
  })

  it('refuses an unsupported document version', async () => {
    const { file, memory } = await fixture()
    await writeFile(file, JSON.stringify({ version: 2, dots: [] }), 'utf8')
    await expect(importLegacyRegistry(memory.domain.table('dots'), file)).rejects.toMatchObject({
      code: 'dots/registry-corrupt',
    })
  })
})
