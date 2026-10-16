import { afterEach, expect, it, vi } from 'vite-plus/test'

const renderer = vi.hoisted(() => ({ build: vi.fn().mockResolvedValue(undefined) }))
vi.mock('vite', () => ({ build: renderer.build }))
afterEach(() => { vi.unstubAllEnvs(); renderer.build.mockClear() })

it('keeps production JSX in the welcome renderer when the pack process has development NODE_ENV', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const { default: configs } = await import('../pack.config.ts')
  const main = configs.find(config => typeof config.onSuccess === 'function')
  if (typeof main?.onSuccess !== 'function') throw new Error('desktop welcome build hook missing')

  // The package hook takes no arguments; capture the real options without writing Desktop artifacts.
  await Reflect.apply(main.onSuccess, undefined, [])

  expect(renderer.build).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  }))
})
