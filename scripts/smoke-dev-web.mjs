import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dsh-dev-web-smoke-'))
const args = ['run', 'dev:web', '--host', '127.0.0.1', '--port', '0', '--no-open']
// --skip-build is for a previously built checkout; CI exercises the default initial build.
if (process.argv.includes('--skip-build')) args.push('--skip-build')
const pnpm = join(dirname(require.resolve('pnpm')), 'bin/pnpm.cjs')
const child = spawn(process.execPath, [pnpm, ...args], {
  cwd: root,
  detached: process.platform !== 'win32',
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const closed = once(child, 'close')
let output = ''
let url
let timer

try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('dev:web did not become ready within 20 minutes')), 20 * 60_000)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`dev:web exited before readiness (${code}, ${signal})`)))
    const consume = chunk => {
      const text = chunk.toString()
      // The authenticated URL stays inside this probe rather than entering CI logs.
      output = (output + text).slice(-2_000_000)
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)\r?\n/)
      if (match && output.includes('dev-web: watching ')) {
        url = match[1]
        resolve()
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
  })
  assert.ok(url)
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /window\.__DSH_BOOT__/)
  assert.equal(child.exitCode, null)
  console.log('dev:web watchers and authenticated HTTP 200 with window.__DSH_BOOT__: PASS')
} catch (error) {
  console.error(output.slice(-12_000).replace(/http:\/\/127\.0\.0\.1:\d+[^\s]*/g, '[local URL]'))
  throw error
} finally {
  clearTimeout(timer)
  if (child.pid !== undefined) {
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 30_000 })
      assert.ifError(killed.error)
      if (child.exitCode === null) assert.equal(killed.status, 0, killed.stderr)
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
  }
  await closed
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
