/**
 * Discover and compose repository pack entries. Only an actual Host pass loads
 * the built Typert generator; importing this module needs no build artifacts.
 * The public CLI adapter lives in scripts/pack/vite.config.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync, globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TsdownPlugin, UserConfig } from 'vite-plus/pack'
import { composeMemberEntries, type MemberPackConfig, type PackMode } from './scripts/pack/config.ts'
import { WORKSPACE_TYPERT_FACES } from './scripts/typert-faces.ts'

export type { MemberPackConfig, PackMode } from './scripts/pack/config.ts'

/** Inputs shared by the public pack adapter and the client bundle watcher. */
export interface CreatePackEntriesOptions {
  /** Absolute repository root; discovery never depends on process.cwd(). */
  readonly root: string
  /** Host reflection, Client artifacts, unset-face source watch, or an independent build without Typert. */
  readonly mode: PackMode
  /** Repository-relative member directories; absent selects the workspace pass, standalone requires explicit members. */
  readonly members?: readonly string[]
}

/**
 * Discover current workspace manifests and evaluate their package-local configs.
 * Config contents qualify import URLs so changes to a member config reload on
 * the next call; imports of its helpers retain normal ESM caching.
 * @param options - Absolute repository root, pass, and optional member selection.
 * @returns Directory-sorted pack entries with manifest-derived names and absolute member-relative working directories.
 * @throws If the root is relative, members are unknown, a manifest/config is invalid,
 * the selected corpus emits no entries, or a Host pass cannot load built Typert.
 * Config evaluation errors propagate before any bundling starts; callers own build failure reporting.
 */
export async function createPackEntries(options: CreatePackEntriesOptions): Promise<UserConfig[]> {
  const { root, mode, members } = options
  if (!isAbsolute(root)) throw new Error(`pack: repository root must be absolute, received ${root}`)
  if (mode === 'standalone' && members === undefined) {
    throw new Error('pack: standalone mode requires explicit member directories')
  }
  const manifests = globSync([
    'vendor/*/package.json',
    'packages/*/*/package.json',
    'apps/*/package.json',
    'benchmarks/package.json',
  ], { cwd: root }).map(path => path.replaceAll('\\', '/'))
  const discovered = new Set(manifests.map(path => dirname(path).replaceAll('\\', '/')))
  const selected = members === undefined
    ? [...discovered].filter(directory => directory.startsWith('vendor/')
      || directory.startsWith('packages/')
      || directory === 'apps/cli'
      || (mode !== 'client' && directory === 'apps/desktop-host'))
    : [...new Set(members.map(directory => directory.replaceAll('\\', '/')))]
  for (const directory of selected) {
    if (!discovered.has(directory)) throw new Error(`pack: unknown workspace member ${directory}`)
  }
  if (selected.length === 0) throw new Error(`pack: ${mode} selected an empty workspace corpus under ${root}`)
  const entries: UserConfig[] = []
  for (const directory of selected.sort()) {
    const cwd = resolve(root, directory)
    const manifestPath = resolve(cwd, 'package.json')
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)
      || typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`pack: ${manifestPath} must declare a nonempty package name`)
    }
    const configPath = resolve(cwd, 'pack.config.ts')
    let config: MemberPackConfig | undefined
    if (existsSync(configPath)) {
      const content = await readFile(configPath)
      const url = pathToFileURL(configPath)
      url.searchParams.set('content', createHash('sha256').update(content).digest('hex'))
      const loaded: { default?: MemberPackConfig } = await import(url.href)
      if (loaded.default === undefined) throw new Error(`pack: ${configPath} must default-export a member config`)
      config = loaded.default
    }
    entries.push(...composeMemberEntries({
      directory: cwd, name: manifest.name, ...(config === undefined ? {} : { config }),
    }, mode, process.env))
  }
  if (entries.length === 0) throw new Error(`pack: ${mode} selected no build entries under ${root}`)
  if (mode === 'host') {
    const pluginPath = resolve(root, 'packages/typert/generator/lib/types/tsdown-plugin.js')
    const { typertPlugin }: {
      typertPlugin: (options: { mode: 'workspace'; faces: typeof WORKSPACE_TYPERT_FACES }) => TsdownPlugin
    } = await import(pathToFileURL(pluginPath).href)
    const plugin = typertPlugin({ mode: 'workspace', faces: WORKSPACE_TYPERT_FACES })
    for (const entry of entries) entry.plugins = [plugin, entry.plugins]
  }
  return entries
}
