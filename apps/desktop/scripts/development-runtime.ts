/** Resolve unpackaged Desktop payloads independently of supported distribution targets. */

import { join, resolve } from 'node:path'
import type { PrimaryRuntimeTarget } from '../../../scripts/primary-runtime/prepare.ts'
import { desktopTargetBuildPaths, desktopTargetPlatform, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'

/** Locked payload and resource directories selected for one development launch. */
export interface DevelopmentRuntime {
  readonly target: PrimaryRuntimeTarget
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: 'arm64' | 'x64'
  /** Resource directory receiving primary-runtime/ and office-skills/. */
  readonly output: string
  readonly cache: string
}

/**
 * Select development resources, including native Linux payloads unavailable to packaging.
 * @param env - Target overrides, with DSH_DESKTOP_TARGET_* taking precedence over npm_config_*.
 * @param hostPlatform - Platform used when no override exists.
 * @param hostArch - Architecture used when no override exists; Windows defaults to x64.
 * @returns Payload identity and directories shared by preparation and launch.
 * @throws When the selected platform or architecture has no supported payload.
 */
export function resolveDevelopmentRuntime(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DevelopmentRuntime {
  const platform = env.DSH_DESKTOP_TARGET_PLATFORM ?? env.npm_config_platform ?? hostPlatform
  if (platform !== 'linux') {
    const target = resolveDesktopBuildTarget(env, hostPlatform, hostArch)
    const paths = desktopTargetBuildPaths(target)
    return { target, ...desktopTargetPlatform(target), output: paths.runtime, cache: paths.downloads }
  }
  const arch = env.DSH_DESKTOP_TARGET_ARCH ?? env.npm_config_arch ?? hostArch
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`desktop development: unsupported target linux-${arch}; use Linux x64 or arm64`)
  }
  const target = `linux-${arch}` as const
  const root = resolve(import.meta.dirname, '..', '.desktop-build')
  return { target, platform, arch, output: join(root, 'targets', target, 'runtime'), cache: join(root, 'downloads') }
}
