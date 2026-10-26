import { describe, expect, it } from 'vite-plus/test'
import { en, zh } from '../src/client/locales.ts'

describe('ChatGPT Client locale dictionaries', () => {
  it('keeps the same translated key set in English and Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('names the Plugins page card and its one-line summary', () => {
    expect(en.nav).not.toBe('')
    expect(en.summary).not.toBe('')
    expect(zh.summary).not.toBe('')
  })
})
