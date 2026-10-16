/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload, type PreparePrimaryRuntimeOptions } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

/** Desktop preparation overrides; omitted preparation selects the packaging target. */
export interface DesktopPrimaryRuntimeOptions {
  /** Explicit development payload and directories; packaging resolves these from its environment. */
  readonly preparation?: Pick<PreparePrimaryRuntimeOptions, 'target' | 'output' | 'cache'>
  /** Signed Windows packaging defers execution until its supervised signing stage. */
  readonly deferSmoke?: boolean
}

function packagingPreparation(): Pick<PreparePrimaryRuntimeOptions, 'target' | 'output' | 'cache'> {
  const target = resolveDesktopBuildTarget()
  const paths = desktopTargetBuildPaths(target)
  return { target, output: paths.runtime, cache: paths.downloads }
}

/**
 * Prepare Desktop resources for a packaging target or an explicit development payload.
 * @param options - Development resource selection and optional deferred execution checks.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: DesktopPrimaryRuntimeOptions = {}): Promise<void> {
  const { target, output, cache } = options.preparation ?? packagingPreparation()
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await preparePayload({ target, output, cache, version })
  if (!options.deferSmoke) smokePrimaryRuntime(join(output, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()
