/** Build-target selection shared by the CLI runner and its Vite+ adapter. */
import type { CreatePackEntriesOptions } from '../../pack.config.ts'

/** Targets accepted by the repository's build-script runner. */
export type PackTarget = 'host' | 'client' | 'desktop' | 'bench' | 'preview'

/**
 * Parse the runner's single positional target without forwarding arbitrary bundler flags.
 * @param args - Arguments after the script path.
 * @returns The selected build target.
 * @throws If there is not exactly one recognized target.
 */
export function parsePackTarget(args: readonly string[]): PackTarget {
  const target = args[0]
  if (args.length === 1
    && (target === 'host' || target === 'client' || target === 'desktop' || target === 'bench' || target === 'preview')) {
    return target
  }
  throw new Error('pack: expected exactly one target: host|client|desktop|bench|preview')
}

/**
 * Resolve an adapter target into one repository pack pass.
 * @param root - Absolute repository root passed to the shared resolver.
 * @param target - Explicit DSH_PACK_TARGET selected by the runner.
 * @returns The selected resolver pass.
 * @throws If the environment does not select a known target.
 */
export function packTargetPasses(root: string, target: string | undefined): CreatePackEntriesOptions[] {
  switch (target) {
    case 'host': return [{ root, mode: 'host' }]
    case 'client': return [{ root, mode: 'client' }]
    case 'desktop': return [{ root, mode: 'standalone', members: ['apps/desktop'] }]
    case 'bench': return [{ root, mode: 'standalone', members: ['benchmarks'] }]
    case 'preview': return [{
      root,
      mode: 'standalone',
      members: ['packages/experimental/webworker-runtime', 'packages/experimental/webworker-packer'],
    }]
    default: throw new Error(`pack: DSH_PACK_TARGET must be host|client|desktop|bench|preview, received ${String(target)}`)
  }
}
