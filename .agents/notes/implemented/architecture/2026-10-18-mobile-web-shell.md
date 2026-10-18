# Agent Note: A phone-width shell for the Web GUI

Status: implemented

English | [中文](2026-10-18-mobile-web-shell.zh.md)

## Problem

The Web GUI is a fixed-height three-column application laid out for desktop windows. On a phone-width Safari window it kept the 56px navigation rail (leaving 334px for the conversation on a 390px screen), sized the mount point from the layout viewport, ignored the notch and home indicator, and let iOS zoom the page whenever the composer took focus.

Four of those are platform behaviour rather than styling: the visual viewport shrinks without resizing the layout viewport (software keyboard, collapsing toolbar, pinch zoom); `viewport-fit=cover` moves content under the notch and the home indicator; iOS Safari ignores `user-scalable=no` and zooms any focused text control below 16px; and a pull-to-refresh gesture over the shell reloads the page, dropping the live connection and the draft.

## Decision

### The mount point follows the visual viewport

`dsh-client-web` publishes the visual viewport's height as `--dsh-viewport-height` (falling back to `innerHeight`) and marks `html[data-soft-keyboard]` while the visible height is at least 120px short of the layout height; the shell sheet sizes `#root` from that variable. The visual viewport's `offsetTop` is not projected: the body does not scroll, so Safari does not pan the page when a field takes focus, and translating the mount point would move every fixed overlay that computes its own placement. Overlays clamp themselves to the same visible rectangle through `visibleViewport()` in ui-primitives, so a menu opened over the keyboard stays reachable.

### Safe areas are published once

`--dsh-safe-top`, `-right`, `-bottom`, and `-left` come from `env(safe-area-inset-*)` on the root element. The frame applies the vertical bands; the sidebar column, the drawer, the centre's header and composer, and the fullscreen right panel apply the horizontal ones, so a full-bleed overlay pads its own content instead of being inset by the frame. The bottom inset drops while the keyboard is open, because the keyboard covers the home indicator.

### 768px is the phone breakpoint

Below 768px — the width at which the right panel already presents fullscreen — the left navigation is a drawer: the frame reserves no track for it, removes the rail, and swaps the same sidebar element's class, so crossing the breakpoint keeps the occupant mounted with its scroll position and stores. The frame mounts the `shell.leading` seat there, which gives ui-sidebar's existing reopen and New Session controls the header's leading corner. A manually expanded navigation clears when crossing either 768px or 1024px, because the expanded state is a different surface on the other side. 768–1024px keeps the column and its rail.

Both side surfaces also open from an edge swipe and close when dragged back toward the edge they came from, through `installEdgeSwipe` and `installSwipeDismiss` in ui-primitives: a start band 24px from the visible viewport edge, a 48px completion distance, and an axis decision after 10px that leaves vertical drags, touches outside the allowed area, touches that begin on an open drawer, scrim, or dialog, and dismiss drags starting in horizontally scrolling content or on a docking-kit tab or divider to the browser. Each listener exists only while its surface is in the state that gesture changes. iOS Safari's own back gesture owns the extreme leading edge, so the header control remains the reliable entry there.

### Text entry has a floor on touch

Text-entry controls compute at least 16px on `(pointer: coarse)`. iOS Safari zooms the page for anything smaller and ignores `user-scalable=no`, so this is the only fix that keeps pinch zoom available. The rule lives in the shell sheet and outranks feature sheets, which keep their desktop sizes; the composer card follows it so its placeholder and toolbar grow with the draft.

## Alternatives considered

- **Keep the 56px rail below 768px.** The rail costs one seventh of a 390px frame, and expanding it squeezes the conversation to 110px. A drawer leaves the conversation full-bleed and keeps the same navigation content.
- **Make 1024px the drawer breakpoint.** That would replace the column for desktop windows that still have room for it. 768px already marks the width where the right panel stops pushing and covers the frame, so both sidebars change presentation at one width.
- **Block the focus zoom with `maximum-scale=1`.** iOS ignores `user-scalable=no` for the zoom-on-focus decision, and removing pinch zoom would remove accessibility scaling that users rely on. The 16px floor leaves pinch zoom intact.
- **Translate the mount point by the visual viewport's `offsetTop`.** A transformed `#root` becomes the containing block for its fixed descendants, and body-portalled overlays would no longer share its origin. The body does not scroll, so the offset stays at zero in the states this shell produces.
- **Keep `overscroll-behavior: none` on every pointer.** Once the root scroller refuses chaining, Chromium hands Home and End to it instead of the focused editor, stranding the composer caret. Pull-to-refresh exists on touch, so the containment applies there only.

## Consequences

- `apps/web/tests/mobile-shell.e2e.ts` holds the phone-frame contract: no page-wide horizontal overflow, a mount height equal to the viewport, the drawer opening from the leading seat or an edge swipe and closing on Escape, the scrim, its own reverse drag, or the surface it revealed, a composer inside the visible rectangle with 16px text, and a fullscreen right panel opened by its header control or the trailing-edge swipe and closed by its reverse drag.
- `composer-focus.e2e.ts` is the regression that shaped the overscroll rule; it exercises Home, End, and caret restoration on a fine pointer.
- Settings becomes a full-bleed panel with a horizontal section strip below 768px. The directory picker, the model menu, and the right panel are exercised at 390px by the same end-to-end scenario.
- Landscape phones reach 844px and keep the rail layout. `MOBILE_MAX` in `packages/client/ui-layout/src/client/columns.ts` is the single value to change if that trade-off needs revisiting.
- The install surface ships with the decision: `display: standalone`, 192/512 maskable PNGs generated from the shipped favicon, an `apple-touch-icon`, and the iOS capable/title metas. `theme-color` stays owned by the theme presenter.
