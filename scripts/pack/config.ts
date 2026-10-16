/** Pure composition of member pack configs; artifact loading belongs to the root resolver. */
import { resolve } from 'node:path'
import { mergeConfig, type UserConfig } from 'vite-plus/pack'

/** The repository pass selecting member factories and workspace reflection. */
export type PackMode = 'host' | 'client' | 'watch' | 'standalone'

/** Member factories receive only the bundler environment used by the repository's face presets. */
export type MemberPackConfig =
  | UserConfig
  | readonly UserConfig[]
  | ((context: Pick<UserConfig, 'env'>) => UserConfig | readonly UserConfig[])

/** One discovered manifest and its optional package-local config. */
export interface PackMember {
  /** Absolute directory containing the manifest and config. */
  readonly directory: string
  /** Package name declared by the member manifest. */
  readonly name: string
  /** An absent config selects repository defaults; an empty array retains the workspace fallback. */
  readonly config?: MemberPackConfig
}

/**
 * Compose one member over repository defaults without loading built artifacts.
 * An empty config array retains the old workspace fallback; `entry: ''` skips it.
 * @param member - Absolute member directory, manifest name, and optional config.
 * @param mode - Host/Client face, unset-face source watch, or independent build.
 * @param environment - Environment copied into the factory with a canonical face selector.
 * @returns Member entries with absolute working directories and preserved hooks/plugins.
 */
export function composeMemberEntries(
  member: PackMember,
  mode: PackMode,
  environment: NodeJS.ProcessEnv,
): UserConfig[] {
  const defaults: UserConfig = {
    name: member.name,
    cwd: member.directory,
    entry: mode === 'client' ? '' : ['lib/types/{index,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
  const env = { ...environment }
  if (mode === 'host' || mode === 'client') env.DSH_BUILD_FACE = mode
  else delete env.DSH_BUILD_FACE
  const selected = typeof member.config === 'function' ? member.config({ env }) : member.config
  const declared = selected === undefined ? [] : Array.isArray(selected) ? selected : [selected]
  const entries: readonly UserConfig[] = declared.length === 0 ? [defaults] : declared
  return entries.flatMap((entry) => {
    const merged = entry === defaults ? defaults : mergeConfig(defaults, entry)
    if (merged.entry === '') return []
    // The bundler's merge helper prepends an undefined plugin slot even when defaults declare none.
    if (entry.plugins !== undefined) merged.plugins = entry.plugins
    merged.cwd = resolve(member.directory, entry.cwd ?? '.')
    return [merged]
  })
}
