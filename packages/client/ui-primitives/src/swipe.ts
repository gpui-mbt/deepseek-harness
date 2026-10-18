/**
 * Horizontal swipe gestures used by the side surfaces.
 *
 * Two gestures share one tracker: an edge swipe reveals a surface (rightward
 * from the leading edge for navigation, leftward from the trailing edge for the
 * right panel), and a dismiss swipe sends it back the way it came. Both are
 * deliberately narrow and late-claiming — the axis is decided only after the
 * finger has moved, and the touch is taken over (and scrolling stopped) only
 * once the drag is clearly horizontal. Vertical drags, a touch that starts
 * outside the allowed area, a touch on an open drawer, scrim, or dialog, and a
 * touch on a horizontally scrolling region or a docking-kit drag affordance stay
 * with the browser.
 *
 * `touchmove` is registered for the duration of a qualifying gesture rather than
 * for the page's lifetime: a permanently non-passive document listener would
 * make every touch scroll wait on the main thread.
 * @module @deepseek-ai/dsh-client-ui-primitives/swipe
 */
import { visibleViewport } from './visible-viewport.ts'

/** Distance from the edge, in px, where an edge swipe may begin. */
const DEFAULT_BAND = 24

/** Travel toward the gesture's direction, in px, that completes it. */
const DEFAULT_DISTANCE = 48

/** Movement, in px, before the gesture decides which axis it is on. */
const AXIS_SLOP = 10

/** How much one axis must dominate the other before the gesture claims it. */
const DOMINANCE = 1.2

/** Surfaces whose own gestures own a touch that starts inside them. */
const EDGE_BLOCKED = '[data-drawer], [data-drawer-scrim], [role="dialog"], [aria-modal="true"]'

/** Docking-kit controls that drag on the same movement the dismiss gesture reads. */
const DISMISS_BLOCKED = '[data-dockkit-tab], [data-dockkit-divider], [data-dockkit-split-handle]'

/** Inputs for {@link installEdgeSwipe}. */
export interface EdgeSwipeOptions {
  /** Viewport edge the gesture starts from. */
  readonly edge: 'left' | 'right'
  /** Called once when a gesture that started at the edge completes. */
  readonly onSwipe: () => void
  /** Distance from the edge, in px, where a gesture may start. */
  readonly band?: number
  /** Travel toward the opposite edge, in px, that completes the gesture. */
  readonly distance?: number
}

/** Inputs for {@link installSwipeDismiss}. */
export interface SwipeDismissOptions {
  /** Surface the gesture dismisses; a touch must start inside it. */
  readonly element: Element | null
  /** Direction the finger travels to dismiss: toward the edge the surface came from. */
  readonly direction: 'left' | 'right'
  /** Called once when a gesture inside the surface completes. */
  readonly onSwipe: () => void
  /** Travel in px that completes the gesture. */
  readonly distance?: number
}

/** One horizontal gesture detector, before its start rule is applied. */
interface SwipeTracker {
  /** Direction the finger must travel, as the sign of its horizontal delta. */
  readonly toward: 1 | -1
  readonly distance: number
  /** Whether a touch that began at this point may take over the gesture. */
  readonly accepts: (touch: Touch) => boolean
  readonly onSwipe: () => void
}

/** One in-flight gesture, retained from touchstart until it settles. */
interface Tracking {
  readonly startX: number
  readonly startY: number
  /** Travel toward the revealed side; negative against it. */
  dx: number
  /** Whether the gesture has claimed the horizontal axis. */
  claimed: boolean
}

/**
 * Whether an element's ancestors scroll horizontally with overflow, in which
 * case a horizontal drag belongs to that scroller.
 * @param target - the element the touch started on.
 * @returns true when a horizontal drag would scroll rather than dismiss.
 */
function scrollsHorizontally(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth) return true
  }
  return false
}

/**
 * Whether the touch started inside one of the selectors' matching subtrees.
 * @param target - the element the touch started on.
 * @param selector - the surfaces that own the gesture themselves.
 * @returns true when the browser keeps the touch.
 */
function inside(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null
}

/**
 * Track one horizontal gesture from the document.
 * @param tracker - direction, distance, start rule, and completion callback.
 * @returns a disposer that removes every listener and drops a pending gesture.
 */
function trackSwipe(tracker: SwipeTracker): () => void {
  const { toward, distance } = tracker
  let tracking: Tracking | null = null

  const stop = (): void => {
    tracking = null
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.removeEventListener('touchcancel', onCancel)
  }

  const onMove = (event: TouchEvent): void => {
    if (tracking === null) return
    const touch = event.touches[0]
    // A second finger means the reader is pinching or scrolling with two
    // hands: drop the gesture rather than fight for it.
    if (touch === undefined || event.touches.length !== 1) {
      stop()
      return
    }
    const dx = touch.clientX - tracking.startX
    const dy = touch.clientY - tracking.startY
    if (!tracking.claimed) {
      if (Math.abs(dy) > AXIS_SLOP && Math.abs(dy) >= Math.abs(dx) * DOMINANCE) {
        // The browser owns a vertical drag: keep scrolling.
        stop()
        return
      }
      if (Math.abs(dx) <= AXIS_SLOP || Math.abs(dx) < Math.abs(dy) * DOMINANCE) return
      if (Math.sign(dx) !== toward) {
        stop()
        return
      }
      tracking.claimed = true
    }
    tracking.dx = dx
    if (event.cancelable) event.preventDefault()
  }

  const onEnd = (): void => {
    const current = tracking
    stop()
    if (current !== null && current.claimed && toward * current.dx >= distance) tracker.onSwipe()
  }

  const onCancel = (): void => {
    stop()
  }

  const onStart = (event: TouchEvent): void => {
    if (tracking !== null || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (touch === undefined || !tracker.accepts(touch)) return
    tracking = { startX: touch.clientX, startY: touch.clientY, dx: 0, claimed: false }
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
  }

  document.addEventListener('touchstart', onStart, { passive: true })
  return () => {
    document.removeEventListener('touchstart', onStart)
    stop()
  }
}

/**
 * Install a swipe that starts in a band at a viewport edge.
 * @param options - the source edge, the completion distance, and the callback.
 * @returns a disposer that removes every listener and drops a pending gesture.
 */
export function installEdgeSwipe(options: EdgeSwipeOptions): () => void {
  const band = options.band ?? DEFAULT_BAND
  const edge = options.edge
  const withinBand = (x: number): boolean => {
    const view = visibleViewport()
    const fromEdge = edge === 'left' ? x - view.left : view.left + view.width - x
    return fromEdge >= 0 && fromEdge <= band
  }
  return trackSwipe({
    toward: edge === 'left' ? 1 : -1,
    distance: options.distance ?? DEFAULT_DISTANCE,
    onSwipe: options.onSwipe,
    accepts: touch => withinBand(touch.clientX) && !inside(touch.target, EDGE_BLOCKED),
  })
}

/**
 * Install a swipe that dismisses a surface, starting inside it.
 * @param options - the surface, the direction that sends it back, and the callback.
 * @returns a disposer that removes every listener and drops a pending gesture.
 */
export function installSwipeDismiss(options: SwipeDismissOptions): () => void {
  const { element } = options
  return trackSwipe({
    toward: options.direction === 'right' ? 1 : -1,
    distance: options.distance ?? DEFAULT_DISTANCE,
    onSwipe: options.onSwipe,
    accepts: touch => {
      if (element === null || !(touch.target instanceof Node) || !element.contains(touch.target)) return false
      return !inside(touch.target, DISMISS_BLOCKED) && !scrollsHorizontally(touch.target)
    },
  })
}
