// @vitest-environment jsdom
/** Edge swipes reveal a surface; dismiss swipes send it back the way it came. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { installEdgeSwipe, installSwipeDismiss } from '../src/swipe.ts'

/** One dispatched touch event carrying the coordinates the gesture reads. */
function touch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: readonly { x: number; y: number }[],
  target: EventTarget = document.body,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const list = touches.map(point => ({ clientX: point.x, clientY: point.y, target }))
  Object.defineProperty(event, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list })
  Object.defineProperty(event, 'changedTouches', { value: list })
  return event
}

/** Whether the browser would have consumed the event (a claimed gesture). */
function dispatch(event: Event): boolean {
  return document.dispatchEvent(event)
}

/** Drag from one point to another, in a few touchmove steps. */
function swipe(from: { x: number; y: number }, to: { x: number; y: number }, target: EventTarget = document.body, steps = 4): void {
  dispatch(touch('touchstart', [from], target))
  for (let step = 1; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps
    const y = from.y + ((to.y - from.y) * step) / steps
    dispatch(touch('touchmove', [{ x, y }], target))
  }
  dispatch(touch('touchend', [], target))
}

/** A surface element with a given horizontal overflow situation. */
function surface(scrollWidth = 0, clientWidth = 0): HTMLElement {
  const element = document.createElement('div')
  element.style.overflowX = 'auto'
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
  document.body.append(element)
  return element
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('installEdgeSwipe', () => {
  it('completes a swipe that starts inside the leading band', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    swipe({ x: 4, y: 300 }, { x: 120, y: 306 })

    expect(onSwipe).toHaveBeenCalledOnce()
    stop()
  })

  it('completes a swipe that starts inside the trailing band, against the other direction', () => {
    vi.stubGlobal('innerWidth', 390)
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'right', onSwipe })

    swipe({ x: 388, y: 300 }, { x: 280, y: 296 })

    expect(onSwipe).toHaveBeenCalledOnce()
    stop()
  })

  it('ignores a gesture that starts away from the edge', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 300, y: 300 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('leaves a vertical drag to the browser', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    swipe({ x: 4, y: 300 }, { x: 12, y: 460 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('ignores a swipe that stops short of the distance', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe, distance: 80 })

    swipe({ x: 4, y: 300 }, { x: 60, y: 300 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('abandons a gesture moving the other way', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    swipe({ x: 4, y: 300 }, { x: -80, y: 300 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('claims the touch only once the drag is clearly horizontal', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    dispatch(touch('touchstart', [{ x: 4, y: 300 }]))
    // Undecided: a 5px move is not yet a swipe, so the browser keeps the touch.
    expect(dispatch(touch('touchmove', [{ x: 9, y: 301 }]))).toBe(true)
    // Claimed: the horizontal drag now belongs to the gesture.
    expect(dispatch(touch('touchmove', [{ x: 60, y: 302 }]))).toBe(false)
    stop()
  })

  it('drops the gesture when a second finger lands', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    dispatch(touch('touchstart', [{ x: 4, y: 300 }]))
    dispatch(touch('touchmove', [{ x: 30, y: 300 }]))
    dispatch(
      touch('touchmove', [
        { x: 40, y: 300 },
        { x: 120, y: 400 },
      ]),
    )
    dispatch(touch('touchend', []))

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('drops the gesture when the browser cancels it', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    dispatch(touch('touchstart', [{ x: 4, y: 300 }]))
    dispatch(touch('touchmove', [{ x: 80, y: 300 }]))
    dispatch(touch('touchcancel', []))
    dispatch(touch('touchend', []))

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('leaves touches that start on an open drawer, scrim, or dialog alone', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })
    const drawer = document.createElement('div')
    drawer.dataset.drawer = ''
    document.body.append(drawer)

    dispatch(touch('touchstart', [{ x: 4, y: 300 }], drawer))
    dispatch(touch('touchmove', [{ x: 120, y: 300 }]))

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('stops listening when disposed mid-gesture', () => {
    const onSwipe = vi.fn()
    const stop = installEdgeSwipe({ edge: 'left', onSwipe })

    dispatch(touch('touchstart', [{ x: 4, y: 300 }]))
    dispatch(touch('touchmove', [{ x: 80, y: 300 }]))
    stop()
    dispatch(touch('touchend', []))

    expect(onSwipe).not.toHaveBeenCalled()
  })
})

describe('installSwipeDismiss', () => {
  it('dismisses on a swipe that starts inside the surface', () => {
    const element = surface()
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 304 }, element)

    expect(onSwipe).toHaveBeenCalledOnce()
    stop()
  })

  it('dismisses a leading surface on a leftward swipe', () => {
    const element = surface()
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'left', onSwipe })

    swipe({ x: 200, y: 300 }, { x: 60, y: 300 }, element)

    expect(onSwipe).toHaveBeenCalledOnce()
    stop()
  })

  it('ignores a drag that starts outside the surface', () => {
    const element = surface()
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 300 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('ignores a drag in the opposite direction', () => {
    const element = surface()
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 260, y: 300 }, { x: 120, y: 300 }, element)

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('leaves horizontally scrolling content to its scroller', () => {
    const element = surface()
    const scroller = document.createElement('pre')
    scroller.style.overflowX = 'auto'
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 320 })
    element.append(scroller)
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 300 }, scroller)

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('dismisses over a scroller whose content fits', () => {
    const element = surface()
    const scroller = document.createElement('pre')
    scroller.style.overflowX = 'auto'
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 200 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 320 })
    element.append(scroller)
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 300 }, scroller)

    expect(onSwipe).toHaveBeenCalledOnce()
    stop()
  })

  it('leaves the docking kit’s own drag affordances alone', () => {
    const element = surface()
    const tab = document.createElement('div')
    tab.dataset.dockkitTab = 'a'
    element.append(tab)
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 300 }, tab)

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })

  it('installs nothing while the surface is absent', () => {
    const onSwipe = vi.fn()
    const stop = installSwipeDismiss({ element: null, direction: 'right', onSwipe })

    swipe({ x: 120, y: 300 }, { x: 260, y: 300 })

    expect(onSwipe).not.toHaveBeenCalled()
    stop()
  })
})
