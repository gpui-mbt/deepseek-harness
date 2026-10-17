import { expect, it } from 'vite-plus/test'
import { apply } from '../src/index.ts'

it('keeps the Browser Host Loader entry inert', () => {
  expect(apply).not.toThrow()
})
