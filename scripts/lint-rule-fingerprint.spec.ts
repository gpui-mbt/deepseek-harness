import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import lintConfig from './lint-config.ts'

type Rules = Record<string, unknown>

interface Profile {
  readonly count: number
  readonly indexes: readonly number[]
  readonly sha256: string
}

// A one-time audit against eslint.config.mjs blob 696b08282885296830189fdafe7051a356806fc2
// mapped @typescript-eslint/* to typescript/* and four extension rules to their
// Oxlint core equivalents. These fingerprints pin the resulting repository
// snapshot; they do not re-evaluate that deleted baseline or track its preset.
const profiles = {
  source: {
    count: 79,
    indexes: [0, 1, 4],
    sha256: '10a14cafcdf3b85b9cf62e47ca43f8cf4b2dac6aee571f5b1bf3c23657dfe8f0',
  },
  example: {
    count: 78,
    indexes: [0, 1, 2, 4],
    sha256: 'a6858a322f65a42dd1349ca5bee394f502d662a74ac7a7079ea52354fbbeb286',
  },
  test: {
    count: 74,
    indexes: [0, 3, 4],
    sha256: '4bf8bd6d99166723a6350124cc64994079ef0713943c59346350e04489072ba4',
  },
} as const satisfies Record<string, Profile>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function severity(value: unknown): 0 | 1 | 2 {
  const level = isUnknownArray(value) ? value[0] : value
  if (level === 'off' || level === 0) return 0
  if (level === 'warn' || level === 'warning' || level === 1) return 1
  if (level === 'error' || level === 2) return 2
  throw new Error(`unsupported lint severity: ${JSON.stringify(level)}`)
}

function normalizedRules(rules: Rules): Rules {
  return Object.fromEntries(
    Object.entries(rules)
      .filter(([, value]) => severity(value) > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const options = isUnknownArray(value) ? value.slice(1) : []
        return [name, [severity(value), ...options]]
      }),
  )
}

function mergedRules(overrides: readonly unknown[], indexes: readonly number[]): Rules {
  const merged: Rules = {}
  for (const index of indexes) {
    const override = overrides[index]
    if (!isRecord(override) || !isRecord(override.rules)) {
      throw new Error(`oxlint.config.ts override ${index} must contain a rules object`)
    }
    Object.assign(merged, override.rules)
  }
  return normalizedRules(merged)
}

describe('Oxlint repository rule fingerprint', () => {
  const overrides: readonly unknown[] = lintConfig.overrides

  it('pins every override field', () => {
    expect(overrides).toHaveLength(8)
  })

  it.each(Object.entries(profiles))('pins the %s rule profile', (_name, profile) => {
    const rules = mergedRules(overrides, profile.indexes)
    const fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex')

    expect(Object.keys(rules)).toHaveLength(profile.count)
    expect(fingerprint).toBe(profile.sha256)
  })
})
