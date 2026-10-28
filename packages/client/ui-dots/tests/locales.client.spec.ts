/** Dots dictionaries: the Chinese copy carries the complete English key set. */
import { describe, expect, it } from 'vite-plus/test'
import { en, zh } from '../src/client/locales.ts'

describe('ui-dots dictionaries', () => {
  it('keeps the Simplified Chinese dictionary key-identical to English', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, key).toBeGreaterThan(0)
    }
  })
})
