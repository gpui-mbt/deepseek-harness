/** Node half of the ChatGPT provider page: a surface plugin with no Host behavior. */
import { describe, expect, it } from 'vite-plus/test'
import { apply } from '../src/index.ts'

describe('ui-chatgpt node half', () => {
  it('applies without registering Host behavior', () => {
    expect(() => {
      apply()
    }).not.toThrow()
  })
})
