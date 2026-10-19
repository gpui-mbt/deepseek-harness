/** Build and launch the unpackaged Electron shell against the current workspace. */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import type { DesktopRelease } from '../src/release.ts'
import { developmentRuntimeDirectory, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { prepareDevelopmentApp } from './development-app.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const BUILD_ROOT = join(APP_ROOT, '.desktop-build')
const DEVELOPMENT_ROOT = join(BUILD_ROOT, 'development')

interface PackageManifest {
  readonly version?: string
}

function packageVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (typeof manifest.version !== 'string') throw new Error(`desktop development: ${subject} has no version`)
  return manifest.version
}

function debugPort(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`desktop development: ${name} must be an integer from 1 through 65535`)
  }
  return port
}

async function run(command: string, args: readonly string[], cwd: string, environment = process.env): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop development: ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

async function runPackageScript(script: string, cwd: string): Promise<void> {
  const packageManager = process.env.npm_execpath
  if (packageManager === undefined || packageManager === '') {
    throw new Error('desktop development: invoke this launcher through pnpm run dev:desktop or start:desktop')
  }
  await run(process.execPath, [packageManager, 'run', script], cwd)
}

/**
 * Build the Electron command line for an unpackaged development launch.
 * Linux disables the Chromium sandbox by default because the pnpm-installed Electron
 * distribution cannot provide the setuid `chrome-sandbox` helper; set
 * `DSH_DESKTOP_ELECTRON_SANDBOX=1` when the host provides a usable sandbox.
 * @param options - Development ports, browser data directory, and platform.
 * @returns Electron arguments, including the application root.
 */
export function electronDevelopmentArguments(options: {
  readonly mainPort: number
  readonly rendererPort: number
  readonly userData: string
  readonly appRoot?: string
  readonly platform?: NodeJS.Platform
  readonly sandbox?: string | undefined
}): string[] {
  const platform = options.platform ?? process.platform
  return [
    `--inspect=127.0.0.1:${String(options.mainPort)}`,
    `--remote-debugging-port=${String(options.rendererPort)}`,
    ...(platform === 'linux' && options.sandbox !== '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${options.userData}`,
    options.appRoot ?? APP_ROOT,
  ]
}

async function launchElectron(): Promise<void> {
  const require = createRequire(import.meta.url)
  const electron: unknown = require('electron')
  if (typeof electron !== 'string') throw new Error('desktop development: electron executable is unavailable')
  const mainPort = debugPort('DSH_DESKTOP_MAIN_INSPECT_PORT', 9229)
  const rendererPort = debugPort('DSH_DESKTOP_RENDERER_DEBUG_PORT', 9222)
  const hostPort = debugPort('DSH_DESKTOP_HOST_INSPECT_PORT', 9230)
  const home = resolve(process.env.DSH_HOME ?? join(DEVELOPMENT_ROOT, 'home'))
  const userData = resolve(process.env.DSH_DESKTOP_USER_DATA_DIR ?? join(DEVELOPMENT_ROOT, 'electron-user-data'))
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR ?? developmentRuntimeDirectory(),
    DSH_DESKTOP_HOST_INSPECT_PORT: String(hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1',
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  }
  console.log(`desktop development: DSH_HOME=${home}`)
  console.log(`desktop development: userData=${userData}`)
  console.log(`desktop development: inspectors main=${String(mainPort)}, renderer=${String(rendererPort)}, host=${String(hostPort)}`)
  if (process.platform === 'darwin') {
    const executable = prepareDevelopmentApp({
      electron,
      appRoot: APP_ROOT,
      directory: DEVELOPMENT_ROOT,
      home,
      userData,
      mainPort,
      rendererPort,
      hostPort,
      openDevtools: environment.DSH_DESKTOP_OPEN_DEVTOOLS!,
    })
    await run(executable, [], APP_ROOT, environment)
    return
  }
  if (process.platform === 'linux' && process.env.DSH_DESKTOP_ELECTRON_SANDBOX !== '1') {
    console.warn(
      'desktop development: Chromium sandbox disabled for Linux; set DSH_DESKTOP_ELECTRON_SANDBOX=1 when the host provides a usable chrome-sandbox helper',
    )
  }
  await run(
    electron,
    electronDevelopmentArguments({
      mainPort,
      rendererPort,
      userData,
      sandbox: process.env.DSH_DESKTOP_ELECTRON_SANDBOX,
    }),
    APP_ROOT,
    environment,
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false } } })
  if (!values['skip-build']) {
    await runPackageScript('build:artifacts', REPOSITORY_ROOT)
    await runPackageScript('build', APP_ROOT)
  }
  for (const path of [join(APP_ROOT, 'lib', 'main.js'), join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'lib', 'index.js')]) {
    if (!existsSync(path)) throw new Error(`desktop development: missing built artifact ${path}`)
  }
  // These modules reach workspace packages through their built lib/ output, so
  // they can only load after the artifact check above.
  const { prepareDevelopmentProject } = await import('./development-project.ts')
  const { preparePrimaryRuntime } = await import('./prepare-primary-runtime.ts')
  const version = packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const pnpmVersion = packageVersion(join(APP_ROOT, 'node_modules', 'pnpm', 'package.json'), 'pnpm package')
  const release: DesktopRelease = {
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: execFileSync(createRequire(import.meta.url)('electron') as string, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).trim(),
    pnpmVersion,
  }
  prepareDevelopmentProject({
    projectDir: join(DEVELOPMENT_ROOT, 'project'),
    cliDir: join(REPOSITORY_ROOT, 'apps', 'cli'),
    hostDir: join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
    dependencyDir: join(REPOSITORY_ROOT, 'node_modules', '.pnpm', 'node_modules'),
    release,
    target: resolveDesktopBuildTarget(),
  })
  await preparePrimaryRuntime()
  await launchElectron()
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
