/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar), the drag handles (pointer capture + rAF throttle), the column
 * solve (columns.ts), and the child-slot render decisions: the sidebar slot
 * receives live parameters from that solve. The root-scoped main slot selects
 * the Conversation or a global panel. Each column occupant owns its Session
 * binding and reports the geometry it needs.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { installEdgeSwipe, installSwipeDismiss } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CENTER_MIN,
  clampWidth,
  computeColumns,
  DRAWER_MAX_RATIO,
  MOBILE_MAX,
  RIGHTBAR_DEFAULT_RATIO,
  RIGHTBAR_MAX_RATIO,
  RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
} from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps = PropsRuntime<'root'> &
  PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.leading'> &
  PropsStore<ReturnType<typeof createLayoutStore>> &
  PropsLocale<'common'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return (
    <div className={css.rightbarCol} data-rightbar-col>
      {props.children}
    </div>
  )
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'rightbar'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (capture.current?.id !== e.pointerId) return
      callbacks.current.onDrag(e.clientX - origin.current)
      endDrag()
    },
    [endDrag],
  )
  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (capture.current?.id === e.pointerId) endDrag()
    },
    [endDrag],
  )

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({ useStore, useSessions, usePanelInfo, actions, renderSlot, t }: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  // Below MOBILE_MAX the navigation is a drawer over the centre: it never takes
  // a track, and the collapsed rail disappears with the column.
  const mobile = viewport < MOBILE_MAX
  const navigationHidden = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const drawerOpen = mobile && !navigationHidden
  const drawerWidth = Math.min(SIDEBAR_DEFAULT, Math.round(viewport * DRAWER_MAX_RATIO))
  const sidebarPreference = navigationHidden ? 0 : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // Desktop reopen controls occupy the frame's shell.leading seat (macOS) or
  // the Windows caption row; neither platform keeps an icon rail.
  const darwin = document.documentElement.dataset.platform === 'darwin'
  const collapsedWidth = darwin || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED
  // The drawer is out of flow, so the frame's own columns are the centre and
  // the right track only; a zero side column and a zero collapsed width make
  // computeColumns price that same frame.
  const columnSidebar = mobile ? 0 : sidebarPreference
  const columnCollapsed = mobile ? 0 : collapsedWidth
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : columnSidebar, rightbarPreference, columnCollapsed)
  const cols = computeColumns(viewport, columnSidebar, layoutInfo.rightbarTrack ? rightbarPreference : 0, columnCollapsed)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  // Track easing is scoped to a discrete open/close toggle: data-animating
  // goes up when the collapse state or the rightbar track flips and comes down
  // at transition end (timeout as the reduced-motion/covered-frame fallback).
  // Steady-state viewport updates stay instant (AppFrame.module.css), and so
  // does a toggle arriving together with a viewport change — that is the
  // responsive auto-collapse firing mid window-resize, where easing would
  // chase the live window edge. The counter restarts the settle window when a
  // re-toggle interrupts a running transition.
  const [animating, setAnimating] = useState(0)
  const trackToggle = `${navigationHidden}:${layoutInfo.rightbarTrack}`
  const previousToggle = useRef(trackToggle)
  const previousViewport = useRef(viewport)
  useLayoutEffect(() => {
    const viewportChanged = previousViewport.current !== viewport
    previousViewport.current = viewport
    if (previousToggle.current === trackToggle) return
    previousToggle.current = trackToggle
    if (viewportChanged) return
    setAnimating(token => token + 1)
  }, [trackToggle, viewport])
  useEffect(() => {
    if (animating === 0) return
    const frame = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (frame === null) return
    const settle = () => {
      setAnimating(0)
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === frame && event.propertyName === 'grid-template-columns') settle()
    }
    frame.addEventListener('transitionend', onTransitionEnd)
    const timer = setTimeout(settle, 600)
    return () => {
      frame.removeEventListener('transitionend', onTransitionEnd)
      clearTimeout(timer)
    }
  }, [animating])
  const onDragEnd = useCallback(() => {
    setDragging(false)
  }, [])
  const onSidebarStart = useCallback(() => {
    sidebarBase.current = colsRef.current.sidebar
    setDragging(true)
  }, [])
  const onSidebarDrag = useCallback(
    (dx: number) => {
      actions.setSidebar(sidebarBase.current + dx)
    },
    [actions],
  )
  const onRightbarStart = useCallback(() => {
    rightbarBase.current = rightbarWidth.current
    setDragging(true)
  }, [])
  const onRightbarDrag = useCallback(
    (dx: number) => {
      actions.setRightbar(rightbarBase.current - dx)
    },
    [actions],
  )
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  // The rendered template lets the grid solve the squeeze natively: the centre
  // declares its protected minimum and the right column bids up to the clamped
  // preference, so a window resize lands in the same layout pass as the frame
  // edge. The JS solve lags the viewport by a ResizeObserver + rAF frame; when
  // it priced the squeeze itself, the centre column absorbed each width change
  // whole and was corrected two frames later — visible jitter. cols keeps only
  // the discrete decisions (track present, collapse state) and the drag base.
  const rightbarMax = cols.rightbar === 0 ? 0 : clampWidth(rightbarPreference, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO)
  const sidebar = useMemo(
    () =>
      renderSlot('sidebar', {
        // The drawer never collapses: it slides out whole, so its occupant keeps
        // the wide layout in both states.
        collapsed: mobile ? false : navigationHidden,
        width: mobile ? drawerWidth : cols.sidebar,
      }),
    [renderSlot, mobile, navigationHidden, drawerWidth, cols.sidebar],
  )
  const main = useMemo(() => <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />, [usePanelInfo, renderSlot])
  const rightbar = useMemo(
    () => renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 }),
    [renderSlot, normal.rightbar, viewport],
  )
  const bottom = useMemo(() => renderSlot('shell.bottom', {}), [renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
  // Window-chrome seat over the main panels' top-left corner: only a fully
  // hidden sidebar column on macOS desktop leaves window chrome without a
  // home — the Windows zero-width collapse keeps its controls in the caption
  // row (ui-sidebar). AppFrame.module.css publishes the matching
  // --dsh-frame-leading-clearance under the same collapsed condition. A phone
  // frame has no rail at all, so the seat also owns the navigation opener there.
  const leading = useMemo(() => renderSlot('shell.leading', {}), [renderSlot])
  const leadingMounted = mobile || (darwin && navigationHidden)

  const drawerRef = useRef<HTMLDivElement | null>(null)
  const leadingRef = useRef<HTMLDivElement | null>(null)
  const closeDrawer = useCallback(() => {
    if (mobile && !navigationHidden) actions.toggleSidebar()
  }, [actions, mobile, navigationHidden])
  // `inert` has no JSX attribute in React 18: a closed drawer must stay out of
  // the tab order and out of screen readers, and the open one must hold
  // neither.
  useLayoutEffect(() => {
    drawerRef.current?.toggleAttribute('inert', mobile && navigationHidden)
  }, [mobile, navigationHidden])
  // The scrim dismisses the drawer for pointer and keyboard alike.
  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeDrawer, drawerOpen])
  // Choosing a Session or a global panel reveals the surface the reader picked.
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const activeSessionId = useSessions(state =>
    Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id,
  )
  const navigationKey = `${activePanelId ?? ''}|${activeSessionId ?? ''}`
  const previousNavigation = useRef(navigationKey)
  useLayoutEffect(() => {
    if (previousNavigation.current === navigationKey) return
    previousNavigation.current = navigationKey
    closeDrawer()
  }, [closeDrawer, navigationKey])
  // Focus follows the drawer: into it when it opens, back to the seat's opener
  // when it closes. Programmatic focus draws no ring after a tap, so a pointer
  // dismissal leaves the frame looking untouched.
  const drawerWasOpen = useRef(false)
  useLayoutEffect(() => {
    if (!mobile) {
      drawerWasOpen.current = false
      return
    }
    if (drawerOpen === drawerWasOpen.current) return
    drawerWasOpen.current = drawerOpen
    const target = drawerOpen
      ? drawerRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
      : leadingRef.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [drawerOpen, mobile])

  // A phone frame also reveals the navigation with a swipe from the leading
  // edge, which a hand already there can make without reaching for the header.
  // The listener exists only while the drawer is closed: an open drawer owns
  // its own surface, and the gesture must not compete with it.
  useEffect(() => {
    if (!mobile || !navigationHidden) return
    return installEdgeSwipe({
      edge: 'left',
      onSwipe: () => {
        actions.toggleSidebar()
      },
    })
  }, [actions, mobile, navigationHidden])
  // The reverse drag on the drawer itself sends it back; the scrim already
  // dismisses on a touch, so only the panel needs the gesture.
  useEffect(() => {
    if (!mobile || navigationHidden) return
    return installSwipeDismiss({ element: drawerRef.current, direction: 'left', onSwipe: closeDrawer })
  }, [closeDrawer, mobile, navigationHidden])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        ...(document.documentElement.hasAttribute('data-windows-titlebar') ? { '--dsh-windows-sidebar-width': `${cols.sidebar}px` } : {}),
        gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : CENTER_MIN}px, 1fr) minmax(0px, ${rightbarMax}px)`,
      }}
      data-mobile={mobile || undefined}
      data-sidebar-collapsed={navigationHidden || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
      data-animating={animating > 0 || undefined}
    >
      <DocumentTitle productTitle={productTitle} useSessions={useSessions} usePanelInfo={usePanelInfo} />
      <div className={css.scrim} data-drawer-scrim="" data-open={drawerOpen || undefined} aria-hidden="true" onPointerDown={closeDrawer} />
      <div
        ref={drawerRef}
        className={mobile ? css.drawer : css.sidebarCol}
        data-drawer={mobile || undefined}
        data-open={drawerOpen || undefined}
        style={mobile ? { width: drawerWidth } : undefined}
      >
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>{rightbar}</RightbarColumn>
      </>
      <div className={css.bottomRow} data-shell-bottom>
        {bottom}
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {leadingMounted && (
        <div className={css.leadingSeat} data-shell-leading ref={leadingRef}>
          {leading}
        </div>
      )}
      {/* The collapsed rail is fixed-width: no resize handle while closed, and
          a drawer has no column border to drag. */}
      {!mobile && !navigationHidden && (
        <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />
      )}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
