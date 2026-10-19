import { expect, it } from 'vite-plus/test'
import { apply } from '../src/index.ts'

it('registers nothing on the Host', () => {
  expect(() => {
    apply()
  }).not.toThrow()
})
