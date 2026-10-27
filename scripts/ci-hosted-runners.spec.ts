import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vite-plus/test'

interface Job {
  'runs-on'?: string
  env?: Record<string, string>
  steps?: Array<{ run?: string; if?: string; 'continue-on-error'?: boolean }>
  needs?: string[]
}
const ci = yaml.load(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as { jobs: Record<string, Job> }
const jobs = ci.jobs
const context = { vars: {}, github: { event: { pull_request: { user: { login: 'maintainer' } } } }, fromJSON: JSON.parse }
function resolve(value: string): unknown {
  return value.startsWith('${{') ? runInNewContext(value.trim().slice(3, -2), context, { timeout: 1000 }) : value
}

describe('fork standard-hosted CI', () => {
  it.each([
    ['node-24', 'ubuntu-24.04', 'pnpm run check:ci:static'],
    ['node-24-coverage', 'ubuntu-24.04', 'pnpm run check:ci:coverage'],
    ['node-24-consumers', 'ubuntu-24.04', 'pnpm run check:ci:consumers'],
    ['windows-build', 'windows-2025', 'pnpm run check:ci:windows-blocking'],
    ['windows-coverage', 'windows-2025', 'pnpm run check:ci:coverage'],
  ])('runs %s on available hosted runners without dropping its gate', (id, runner, command) => {
    const job = jobs[id]!
    expect(resolve(job['runs-on']!)).toBe(runner)
    const gate = job.steps!.find(step => step.run === command)
    expect(gate).toBeDefined()
    expect(gate?.if).toBeUndefined()
    expect(gate?.['continue-on-error']).not.toBe(true)
    expect(resolve(job.env!.DSH_GATE_CONCURRENCY!)).toBe('1')
  })

  it('retains all six formerly unavailable lanes and their final verdict dependencies', () => {
    expect(resolve(jobs['windows-native-tests']!['runs-on']!)).toBe('windows-2025')
    expect(jobs['all-checks-passed']!.needs).toEqual([
      'node-24',
      'node-24-coverage',
      'node-24-bench',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows-build',
      'windows-native-tests',
    ])
    // Windows coverage remains independently visible, as before; it is not
    // silently removed just because the inherited aggregate omits its result.
    expect(jobs['windows-coverage']).toBeDefined()
  })

  it.each(['node-24-coverage', 'windows-coverage'])('bounds %s without changing exhaustive coverage selection', id => {
    expect(resolve(jobs[id]!.env!.DSH_COVERAGE_MAX_WORKERS!)).toBe('2')
    expect(resolve(jobs[id]!.env!.DSH_COVERAGE_PARTITIONS!)).toBe('2')
    expect(jobs[id]!.env!.DSH_COVERAGE_TEST_TIMEOUT_MS).toBe('90000')
  })
})
