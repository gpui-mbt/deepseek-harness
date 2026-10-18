/**
 * Shell base styles stay independent from the dynamically loaded theme bundle,
 * and the shell sheet is where the darwin window drag surface is declared.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { INTERACTIVE_SELECTOR } from '../src/window-drag/regions.ts'

const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'
const baseCss = readFileSync(fileURLToPath(new URL('../src/base.css', import.meta.url)), 'utf8')

/**
 * Import specifiers of the sheet, in source order. Quote style and surrounding
 * whitespace are intentionally irrelevant; duplicate imports remain visible.
 * @param css - stylesheet text.
 * @returns import specifiers in declaration order.
 */
function importOrder(css: string): string[] {
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map(([, specifier = '']) => specifier)
}

const imports = importOrder(baseCss)
const normalizedCss = baseCss.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\s+/g, ' ')
const literalContentSelectors = ['code', 'pre', '[data-diff]', '[data-read]', '[data-search]', '[data-terminal]']

describe('web shell base.css', () => {
  it('leaves theme styles to the dynamic ui-theme client entry', () => {
    expect(imports).toEqual([])
    expect(baseCss).not.toContain(THEME_PACKAGE)
  })

  it('mounts the application at the visible viewport height', () => {
    // viewport.ts publishes the visual viewport height; the layout height is the
    // fallback for a browser without one and for the first frame.
    expect(normalizedCss).toContain('#root { height: var(--dsh-viewport-height, 100%); }')
  })

  it('keeps the page itself from scrolling or reloading on an overscroll', () => {
    const mount = /html, body \{[^}]*\}/.exec(normalizedCss)
    expect(mount, 'base.css declares no html/body mount rule').not.toBeNull()
    expect(mount![0]).toContain('overflow: hidden;')
    // Touch only: on a fine pointer the refusal would strand the composer
    // caret, because Chromium hands Home/End to the root scroller.
    const touch = /@media \(pointer: coarse\) \{ html, body \{ overscroll-behavior: none; \} \}/.exec(normalizedCss)
    expect(touch, 'base.css declares no coarse-pointer overscroll containment').not.toBeNull()
  })

  it('publishes the safe-area insets and drops the bottom one under the keyboard', () => {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(normalizedCss).toContain(`--dsh-safe-${side}: env(safe-area-inset-${side}, 0px);`)
    }
    expect(normalizedCss).toContain('html[data-soft-keyboard] { --dsh-safe-bottom: 0px; }')
  })

  it('keeps text entry at the touch focus-zoom floor', () => {
    // iOS Safari zooms the page when a focused text control computes below 16px;
    // the shell sheet owns the floor so a feature sheet cannot lower it.
    const rule =
      /@media \(pointer: coarse\) \{ input, textarea, select, \[contenteditable='true'\] \{ font-size: max\(16px, 1em\) !important; \} \}/.exec(
        normalizedCss,
      )
    expect(rule, 'base.css declares no coarse-pointer text-entry floor').not.toBeNull()
  })

  it('declares exactly the interactive subtraction the drag contract publishes', () => {
    // One source for the selector: the model constant. The darwin rule must
    // declare the same list, so a new interactive role is added in one place
    // and a drift between the sheet and the composition model fails here.
    const rule = /html\[data-platform='darwin'\] :is\(([^)]*)\)\s*\{[^}]*app-region:\s*no-drag/.exec(normalizedCss)
    expect(rule, 'base.css declares no darwin interactive no-drag rule').not.toBeNull()
    const declared = rule![1]!
      .split(',')
      .map(part => part.trim())
      .join(', ')
    expect(declared).toBe(INTERACTIVE_SELECTOR)
  })

  it('declares the darwin drag surface through the mark chrome rows set', () => {
    // One rule for the whole surface: a chrome row marks itself
    // `data-window-drag`, so its own box is the draggable geometry and no sheet
    // has to declare drag per row. The ui-theme app-region gate holds the other
    // half — that this is the only darwin drag rule in the package tree.
    expect(normalizedCss).toContain("html[data-platform='darwin'] [data-window-drag] { -webkit-app-region: drag; }")
  })

  it('keeps the one-frame recall mark out of the drag surface while it is set', () => {
    // The shell's drag watcher sets the recall mark while a marked row's box is
    // moving (electron#32341 recollects the window's drag rects only on a
    // computed-value change). The box it subtracts is the body's own, and the row
    // marks inside it still win in document order, so the pulse changes what
    // Electron collects without changing the composed surface.
    expect(normalizedCss).toContain("html[data-platform='darwin'] [data-window-drag-recall] { -webkit-app-region: no-drag; }")
  })

  it('auto-spaces prose while preserving literal content', () => {
    expect(baseCss).toMatch(/body\s*\{[^}]*text-autospace:\s*normal;/)
    expect(normalizedCss).toContain(`${literalContentSelectors.join(', ')} { text-autospace: no-autospace; }`)
  })
})
