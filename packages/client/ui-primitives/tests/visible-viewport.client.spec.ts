// @vitest-environment jsdom
/** The visible rectangle floating surfaces clamp themselves to. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { visibleViewport } from '../src/visible-viewport.ts'

/** The visual viewport jsdom does not implement. */
class VisualViewportStub {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly offsetLeft = 0,
    readonly offsetTop = 0,
  ) {}
}

afterEach(() => {
  Reflect.deleteProperty(window, 'visualViewport')
  vi.unstubAllGlobals()
})

describe('visibleViewport', () => {
  it('falls back to the window where the browser has no visual viewport', () => {
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 640)

    expect(visibleViewport()).toEqual({ left: 0, top: 0, width: 1024, height: 640 })
  })

  it('reports the visible window and its offset inside the layout viewport', () => {
    // A software keyboard shrinks the visible height and a pinch-zoom pans the
    // visible window; fixed-position surfaces need both numbers.
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: new VisualViewportStub(390, 420, 7, 96),
    })
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('innerHeight', 844)

    expect(visibleViewport()).toEqual({ left: 7, top: 96, width: 390, height: 420 })
  })
})
