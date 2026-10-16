/** jsdom font-loading events; layout tests drive their own measurements. */
import { beforeEach, afterEach, vi } from 'vite-plus/test'

const fonts = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (fonts === undefined) Reflect.deleteProperty(document, 'fonts')
  else Object.defineProperty(document, 'fonts', fonts)
})
