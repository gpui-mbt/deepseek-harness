/**
 * The rectangle the user can actually see, in `position: fixed` coordinates.
 *
 * A layout viewport keeps its size on mobile browsers while a software
 * keyboard, a collapsing toolbar, or pinch zoom changes what is on screen.
 * Fixed-position surfaces that clamp themselves to the window would then be
 * placed under the keyboard or under the toolbar. The visual viewport reports
 * both the visible size and the offset of that window within the layout
 * viewport, which is the conversion fixed coordinates need.
 * @module @deepseek-ai/dsh-client-ui-primitives/src/visible-viewport
 */

/** Visible viewport rectangle in layout-viewport (fixed-position) coordinates. */
export interface VisibleViewport {
  /** Inline offset of the visible window from the layout viewport's left edge. */
  readonly left: number
  /** Block offset of the visible window from the layout viewport's top edge. */
  readonly top: number
  /** Visible inline size. */
  readonly width: number
  /** Visible block size. */
  readonly height: number
}

/**
 * Read the visible viewport, falling back to the window where the browser has
 * no visual viewport (and where the two are the same).
 * @returns the visible rectangle in fixed-position coordinates.
 */
export function visibleViewport(): VisibleViewport {
  // Normalized to null: a browser without a visual viewport reports it as an
  // absent property.
  const visual = window.visualViewport ?? null
  return {
    left: visual?.offsetLeft ?? 0,
    top: visual?.offsetTop ?? 0,
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  }
}
