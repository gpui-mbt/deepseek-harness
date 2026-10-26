/** Sidebar glyph for the Dots page: a 3×3 grid of small rings. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Centers of the nine rings, in the 20×20 view box. */
const CELLS = [4.5, 10, 15.5] as const

/**
 * Draw the dot-grid glyph at the size the Sidebar asks for. The Sidebar owns
 * the button, its label, and the selected state around this decorative icon.
 * @param props - the Sidebar's icon share: the requested edge and selected state.
 * @returns the decorative glyph.
 */
export function DotsIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      {CELLS.flatMap(y => CELLS.map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />))}
    </svg>
  )
}
