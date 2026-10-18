/**
 * Phone-width shell over the shipped Web composition.
 *
 * The frame is a fixed-height application laid out for desktop windows: at 390px
 * these are the invariants that keep it usable on a phone — no page-wide
 * horizontal overflow, a mount height that follows the visible viewport, a
 * drawer instead of the 56px rail, a composer whose text stays at the iOS
 * focus-zoom floor, and overlays that stay inside the visible rectangle.
 */
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vite-plus/test'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
} as const

/** One reading of the shell's frame geometry and mobile presentation. */
interface ShellReading {
  width: number
  height: number
  scrollWidth: number
  rootHeight: number
  frameHeight: number
  mobile: boolean
  drawerOpen: string | null
  drawerLeft: number
  drawerWidth: number
  viewportVariable: string
}

/**
 * Read the shell's frame, mount point, and drawer state.
 * @param page - the phone page under test.
 * @returns the settled geometry of one frame.
 */
async function readShell(page: Page): Promise<ShellReading> {
  return await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('[data-shell-overlay]')
    const drawer = document.querySelector<HTMLElement>('[data-drawer]')
    const root = document.getElementById('root')
    if (overlay === null || drawer === null || root === null) throw new Error('phone shell is not mounted')
    const frame = overlay.parentElement
    if (frame === null) throw new Error('frame is missing')
    const box = drawer.getBoundingClientRect()
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      rootHeight: Math.round(root.getBoundingClientRect().height),
      frameHeight: Math.round(frame.getBoundingClientRect().height),
      mobile: frame.hasAttribute('data-mobile'),
      drawerOpen: drawer.getAttribute('data-open'),
      drawerLeft: Math.round(box.left),
      drawerWidth: Math.round(box.width),
      viewportVariable: getComputedStyle(document.documentElement).getPropertyValue('--dsh-viewport-height').trim(),
    }
  })
}

/**
 * Drag one finger across the page, starting at an edge coordinate.
 * @param page - the phone page under test.
 * @param fromX - touch start in CSS px.
 * @param toX - touch end in CSS px.
 * @param y - the row to drag along.
 * @param within - selector of the surface the finger touches; defaults to the page body.
 */
async function swipe(page: Page, fromX: number, toX: number, y = 400, within?: string): Promise<void> {
  await page.evaluate(
    ({ fromX, toX, y, within }) => {
      const target = within === undefined ? document.body : (document.querySelector<HTMLElement>(within) ?? document.body)
      const point = (x: number): Touch => new Touch({ identifier: 1, target, clientX: x, clientY: y })
      const fire = (type: string, x: number): void => {
        const touches = type === 'touchend' ? [] : [point(x)]
        target.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [point(x)] }),
        )
      }
      fire('touchstart', fromX)
      for (const step of [0.25, 0.5, 0.75, 1]) fire('touchmove', fromX + (toX - fromX) * step)
      fire('touchend', toX)
    },
    { fromX, toX, y, within },
  )
}

it('lays the shipped composition out for a 390px phone frame', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await browser.newPage(PHONE)
    failurePage = page
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[data-shell-overlay]').waitFor()

    // 1. The frame is the visible viewport, with no page-wide overflow and no
    //    reserved sidebar track: the phone frame is the centre column alone.
    const initial = await readShell(page)
    expect(initial).toMatchObject({
      width: 390,
      height: 844,
      scrollWidth: 390,
      rootHeight: 844,
      frameHeight: 844,
      mobile: true,
      drawerOpen: null,
      viewportVariable: '844px',
    })
    // The closed drawer sits entirely off the leading edge.
    expect(initial.drawerLeft + initial.drawerWidth).toBeLessThanOrEqual(0)

    // 2. The leading seat replaces the rail as the way into navigation.
    const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
    await opener.waitFor()
    await opener.click()
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(1)
    // The slide settles at the leading edge of the frame.
    await expect.poll(async () => (await readShell(page)).drawerLeft).toBe(0)
    const opened = await readShell(page)
    expect(opened).toMatchObject({ drawerOpen: 'true', drawerLeft: 0, drawerWidth: 280 })
    expect(await page.locator('[data-drawer-scrim][data-open]').count()).toBe(1)

    // 3. Escape and the scrim both dismiss it.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(0)
    await opener.click()
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(1)
    await page.locator('[data-drawer-scrim]').tap({ position: { x: 370, y: 400 } })
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(0)

    // 4. A swipe from the leading edge reaches the same drawer, and a drag that
    //    starts away from the edge stays with the conversation. Dragging the
    //    drawer back toward the edge dismisses it.
    await swipe(page, 120, 300)
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(0)
    await swipe(page, 4, 140)
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(1)
    await swipe(page, 200, 60, 400, '[data-drawer]')
    await expect.poll(() => page.locator('[data-drawer][data-open]').count()).toBe(0)

    // 5. The workspace picker and the live composer fit the phone frame, and
    //    the composer's text stays at iOS Safari's focus-zoom floor.
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'phone-shell')
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const composerBox = await input.boundingBox()
    expect(composerBox).not.toBeNull()
    expect(composerBox!.y).toBeGreaterThanOrEqual(0)
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(844)
    expect(await input.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
    expect((await readShell(page)).scrollWidth).toBe(390)

    // 6. The right panel is the full viewport at this width, and the trailing
    //    edge reveals it too, after the header control collapses it again.
    await page.locator('[data-sidebar-right-expand]').click()
    const panel = page.locator('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]')
    await panel.waitFor()
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(Math.round(panelBox!.width)).toBe(390)
    expect(Math.round(panelBox!.x)).toBe(0)

    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await expect.poll(() => page.locator('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]').count()).toBe(0)
    await swipe(page, 386, 240)
    await expect
      .poll(() => page.locator('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]').count())
      .toBe(1)
    // The panel itself sends it back toward the edge it came from.
    await swipe(page, 120, 260, 400, '[data-sidebar-right-panel="fullscreen"]')
    await expect
      .poll(() => page.locator('[data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]').count())
      .toBe(0)

    // 7. The mount height follows the published visible height (what the shell
    //    observer does when a software keyboard shrinks the visual viewport).
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-viewport-height', '600px')
    })
    expect((await readShell(page)).rootHeight).toBe(600)
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--dsh-viewport-height')
    })

    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'mobile-shell')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
