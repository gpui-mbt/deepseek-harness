import { describe, expect, it } from 'vite-plus/test'
import {
  makeDotId,
  memoryEntry,
  memoryExcerpt,
  normalizeAllowedTools,
  normalizeName,
  normalizePurpose,
  renderContract,
  slugify,
} from '../src/paths.ts'

describe('dot names and paths', () => {
  it('trims and validates names', () => {
    expect(normalizeName('  researcher  ')).toBe('researcher')
    expect(normalizeName('調査担当')).toBe('調査担当')
    expect(() => normalizeName('   ')).toThrow(/blank/u)
    expect(() => normalizeName('a/b')).toThrow(/path separators/u)
    expect(() => normalizeName('a:b')).toThrow(/colons/u)
    expect(() => normalizeName('x'.repeat(65))).toThrow(/64/u)
  })

  it('slugifies ASCII and falls back for non-ASCII names', () => {
    expect(slugify('Research Assistant')).toBe('research-assistant')
    expect(slugify('Café')).toBe('cafe')
    expect(slugify('調査担当')).toBe('dot')
  })

  it('mints stable ids and dot paths', () => {
    expect(makeDotId('Researcher', 'abc123')).toBe('dot-researcher-abc123')
    expect(makeDotId('調査担当', 'abc123')).toBe('dot-dot-abc123')
  })

  it('validates purpose bytes', () => {
    expect(normalizePurpose('  do work  ', 20)).toBe('do work')
    expect(() => normalizePurpose('   ', 20)).toThrow(/blank/u)
    expect(() => normalizePurpose('x'.repeat(21), 20)).toThrow(/20 UTF-8 bytes/u)
  })

  it('normalizes exact and prefix tool patterns', () => {
    expect(normalizeAllowedTools(['read', 'mcp__github__*'])).toEqual(['read', 'mcp__github__*'])
    expect(normalizeAllowedTools([])).toEqual([])
    expect(() => normalizeAllowedTools(['bad pattern'])).toThrow(/Invalid allowed tool pattern/u)
    expect(() => normalizeAllowedTools(['x'.repeat(129)])).toThrow(/1-128/u)
  })
})

describe('contract and memory rendering', () => {
  it('renders purpose, runtime, and allowlist', () => {
    const text = renderContract({
      name: 'researcher',
      purpose: 'Keep the FAQ current.',
      preset: 'standard',
      permissionPreset: 'workspace-write',
      allowedTools: ['read', 'web_search'],
    })
    expect(text).toContain('# Dot: researcher')
    expect(text).toContain('Keep the FAQ current.')
    expect(text).toContain('`standard`')
    expect(text).toContain('`workspace-write`')
    expect(text).toContain('`read`')
    expect(text).toContain('Do not create or manage other dots.')
    expect(renderContract({ name: 'empty', purpose: 'Nothing.', preset: 'standard', allowedTools: [] })).toContain(
      'No tools are allowed for this dot.',
    )
    expect(renderContract({ name: 'open', purpose: 'All.', preset: 'standard' })).toContain(
      'No tool allowlist is configured',
    )
  })

  it('bounds memory to the tail and marks truncation', () => {
    expect(memoryExcerpt('', 10)).toBe('none')
    expect(memoryExcerpt('short', 10)).toBe('short')
    const excerpt = memoryExcerpt('old '.repeat(20), 20)
    expect(excerpt.startsWith('(older memory omitted)')).toBe(true)
    expect(excerpt.length).toBeLessThan(60)
  })

  it('does not split a multibyte character at the memory byte bound', () => {
    const excerpt = memoryExcerpt('あ'.repeat(100), 10)
    expect(excerpt).not.toContain('\ufffd')
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThan(40)
  })

  it('formats dated memory entries on one line', () => {
    expect(memoryEntry('  likes   tea  ', Date.UTC(2026, 9, 18))).toBe('- 2026-10-18: likes tea\n')
  })
})
