/**
 * Projection of the browser's visual viewport onto the document.
 *
 * The app shell is a fixed-height application frame, so its height must be the
 * height the user can actually see. On iOS Safari the layout viewport keeps its
 * height while the software keyboard, the collapsing toolbar, and pinch zoom
 * change the visual viewport; a `height: 100%` root then runs under the
 * keyboard or under the toolbar. This module publishes that visible height as
 * `--dsh-viewport-height` and marks `data-soft-keyboard` while the keyboard
 * covers part of the page, so the shell's base sheet (ui-web base.css) sizes
 * `#root` from it and drops the home-indicator inset the keyboard covers.
 *
 * Only the height is projected. The visual viewport's `offsetTop` is ignored:
 * a page whose body does not scroll is not panned by Safari when a field takes
 * focus, and translating the mount point would move every fixed overlay that
 * hosts its own placement math.
 *
 * Writes are edge-triggered — a resize that does not change the visible height
 * writes nothing — and coalesced onto one animation frame.
 * @module @deepseek-ai/dsh-client-web/src/viewport
 */

/** Custom property carrying the visible viewport height, in px. */
export const VIEWPORT_HEIGHT_VARIABLE = '--dsh-viewport-height'

/** Document attribute set while a software keyboard covers part of the viewport. */
export const SOFT_KEYBOARD_ATTRIBUTE = 'data-soft-keyboard'

/**
 * Visible height shortfall, in px, that only a software keyboard produces. A
 * collapsing toolbar changes the visual viewport by its own smaller step, and a
 * desktop window keeps both heights equal.
 */
const KEYBOARD_COVERAGE = 120

/** Scheduling and mounting seams for {@link installViewportProjection}. */
export interface ViewportProjectionOptions {
  /** Document whose root element receives the projection. */
  readonly document: Document
  /**
   * Schedules one frame callback and returns its canceller. Defaults to the
   * document window's `requestAnimationFrame`.
   */
  readonly scheduleFrame?: (frame: () => void) => () => void
}

/** The projected state, so an unchanged sample writes nothing. */
interface Projection {
  readonly height: number
  readonly keyboard: boolean
}

/**
 * Publish the visual viewport's height and keyboard state on the document root.
 * @param options - the document to project onto and the frame scheduler.
 * @returns a disposer that stops watching and removes the projection.
 */
export function installViewportProjection(options: ViewportProjectionOptions): () => void {
  const root = options.document.documentElement
  const view = options.document.defaultView
  /* v8 ignore next 2 -- the document always has a window in every shell carrier; a detached document has nothing to project. */
  if (view === null) return () => {}
  const schedule =
    options.scheduleFrame ??
    ((frame: () => void): (() => void) => {
      const id = view.requestAnimationFrame(frame)
      return () => {
        view.cancelAnimationFrame(id)
      }
    })

  let pending: (() => void) | undefined
  let published: Projection | undefined

  const project = (): void => {
    pending = undefined
    // Normalized to null: a browser without a visual viewport reports it as an
    // absent property, and every carrier then takes the same fallback.
    const visual = view.visualViewport ?? null
    const height = visual === null ? view.innerHeight : visual.height
    const keyboard = visual !== null && visual.height < view.innerHeight - KEYBOARD_COVERAGE
    if (published?.height === height && published.keyboard === keyboard) return
    published = { height, keyboard }
    root.style.setProperty(VIEWPORT_HEIGHT_VARIABLE, `${String(height)}px`)
    root.toggleAttribute(SOFT_KEYBOARD_ATTRIBUTE, keyboard)
  }

  const request = (): void => {
    pending ??= schedule(project)
  }

  const visual = view.visualViewport ?? null
  // The visual viewport covers the keyboard and the collapsing toolbar; the
  // window resize covers rotation and a browser without a visual viewport.
  visual?.addEventListener('resize', request)
  visual?.addEventListener('scroll', request)
  view.addEventListener('resize', request)
  project()

  return () => {
    visual?.removeEventListener('resize', request)
    visual?.removeEventListener('scroll', request)
    view.removeEventListener('resize', request)
    if (pending !== undefined) {
      pending()
      pending = undefined
    }
    published = undefined
    root.style.removeProperty(VIEWPORT_HEIGHT_VARIABLE)
    root.removeAttribute(SOFT_KEYBOARD_ATTRIBUTE)
  }
}
