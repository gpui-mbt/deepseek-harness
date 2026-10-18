// @vitest-environment jsdom
/** Visual-viewport projection: the shell's mount height and keyboard mark. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  installViewportProjection,
  SOFT_KEYBOARD_ATTRIBUTE,
  VIEWPORT_HEIGHT_VARIABLE,
} from '../src/viewport.ts'

/** The visual viewport jsdom does not implement. */
class VisualViewportStub extends EventTarget {
  height = 844
  width = 390
  offsetTop = 0
  offsetLeft = 0
}

let frames: Map<number, () => void>
let nextFrame: number

/** Run every callback the projection scheduled, once. */
function flushFrames(): void {
  for (const [id, frame] of [...frames]) {
    if (!frames.delete(id)) continue
    frame()
  }
}

/** Frame scheduler that keeps its callbacks for explicit flushing. */
function scheduleFrame(frame: () => void): () => void {
  const id = nextFrame++
  frames.set(id, frame)
  return () => {
    frames.delete(id)
  }
}

/** Install a visual viewport the projection can subscribe to. */
function stubVisualViewport(): VisualViewportStub {
  const visual = new VisualViewportStub()
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual })
  return visual
}

function removeVisualViewport(): void {
  Reflect.deleteProperty(window, 'visualViewport')
}

function heightVariable(): string {
  return document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_VARIABLE)
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('innerHeight', 844)
})

afterEach(() => {
  vi.restoreAllMocks()
  removeVisualViewport()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(SOFT_KEYBOARD_ATTRIBUTE)
  document.documentElement.style.removeProperty(VIEWPORT_HEIGHT_VARIABLE)
})

describe('installViewportProjection', () => {
  it('publishes the visual viewport height on the document root', () => {
    const visual = stubVisualViewport()
    visual.height = 800
    const stop = installViewportProjection({ document, scheduleFrame })

    expect(heightVariable()).toBe('800px')
    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false)
    stop()
  })

  it('marks the keyboard only when the visual viewport is much shorter than the window', () => {
    const visual = stubVisualViewport()
    const stop = installViewportProjection({ document, scheduleFrame })

    // A collapsing toolbar takes a small step; only the keyboard takes a large one.
    visual.height = 760
    visual.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false)

    visual.height = 400
    visual.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(heightVariable()).toBe('400px')
    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(true)

    visual.height = 844
    visual.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false)
    stop()
  })

  it('coalesces samples into one frame and skips an unchanged height', () => {
    const visual = stubVisualViewport()
    const stop = installViewportProjection({ document, scheduleFrame })
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')

    visual.height = 700
    visual.dispatchEvent(new Event('resize'))
    visual.height = 640
    visual.dispatchEvent(new Event('resize'))
    expect(writes).not.toHaveBeenCalled()

    flushFrames()
    expect(writes).toHaveBeenCalledExactlyOnceWith(VIEWPORT_HEIGHT_VARIABLE, '640px')

    visual.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(writes).toHaveBeenCalledOnce()
    stop()
  })

  it('follows the window when the browser has no visual viewport', () => {
    const stop = installViewportProjection({ document, scheduleFrame })
    expect(heightVariable()).toBe('844px')

    vi.stubGlobal('innerHeight', 600)
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(heightVariable()).toBe('600px')
    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false)
    stop()
  })

  it('drops the projection and stops listening when disposed', () => {
    const visual = stubVisualViewport()
    const stop = installViewportProjection({ document, scheduleFrame })
    const writes = vi.spyOn(document.documentElement.style, 'setProperty')

    stop()

    expect(document.documentElement.hasAttribute(SOFT_KEYBOARD_ATTRIBUTE)).toBe(false)
    expect(heightVariable()).toBe('')
    visual.height = 300
    visual.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(writes).not.toHaveBeenCalled()
  })

  it('cancels a scheduled frame when disposed before it runs', () => {
    const visual = stubVisualViewport()
    const stop = installViewportProjection({ document, scheduleFrame })

    visual.height = 300
    visual.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    stop()
    expect(frames.size).toBe(0)
    flushFrames()
    expect(heightVariable()).toBe('')
  })

  it('defaults to the window animation frame scheduler', () => {
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 7)
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const visual = stubVisualViewport()

    const stop = installViewportProjection({ document })
    expect(request).not.toHaveBeenCalled()

    visual.height = 300
    visual.dispatchEvent(new Event('resize'))
    expect(request).toHaveBeenCalledOnce()
    stop()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(7)
    request.mockRestore()
    cancel.mockRestore()
  })
})
