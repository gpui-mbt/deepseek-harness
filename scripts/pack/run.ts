/** Shell-free launcher for the dedicated public Vite+ pack adapter. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pnpmInvocation } from '../pnpm-invocation.ts'
import { parsePackTarget } from './targets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const adapter = fileURLToPath(new URL('.', import.meta.url))

try {
  const target = parsePackTarget(process.argv.slice(2))
  const env = { ...process.env, DSH_PACK_TARGET: target, DSH_BUILD_FACE: target === 'client' ? 'client' : 'host' }
  const invocation = pnpmInvocation(['exec', 'vp', '-C', adapter, 'pack'], env)
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`pack: ${target} stopped by ${result.signal}`)
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
