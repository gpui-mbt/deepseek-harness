/**
 * Rasterize the shipped favicon into the home-screen icons the web manifest
 * and iOS install prompts use.
 *
 * iOS ignores SVG icons and renders a transparent apple-touch-icon on black, so
 * the install surface needs opaque square PNGs. The mark is centered on the
 * light page fill at a size that stays inside a maskable icon's safe circle;
 * `pnpm run icons` regenerates them from `public/favicon.svg`.
 * @module @deepseek-ai/dsh-web-frontend/scripts/generate-app-icons
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

/** One emitted icon: file name, square size in px, and mark share of the side. */
const ICONS = [
  // iOS masks nothing on its own: the mark fills the icon's generous margin.
  { file: 'apple-touch-icon.png', size: 180, mark: 0.64 },
  // Manifest icons are also offered as maskable, where the mark must stay
  // inside the 80% safe circle (a 0.5 side keeps its corners at 35%).
  { file: 'icon-192.png', size: 192, mark: 0.5 },
  { file: 'icon-512.png', size: 512, mark: 0.5 },
] as const

/**
 * Draw one icon and write it beside the favicon.
 * @param options - output file, square size, mark share, and the inlined mark.
 */
async function render(options: { file: string; size: number; mark: number; source: string }): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: options.size, height: options.size } })
    const markSize = Math.round(options.size * options.mark)
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${String(options.size)}px;height:${String(options.size)}px;` +
        'display:grid;place-items:center;background:#ffffff">' +
        `<img alt="" width="${String(markSize)}" height="${String(markSize)}" src="${options.source}">` +
        '</body></html>',
      { waitUntil: 'load' },
    )
    await page.screenshot({ path: join(PUBLIC, options.file), omitBackground: false })
  } finally {
    await browser.close()
  }
}

const svg = await readFile(join(PUBLIC, 'favicon.svg'), 'utf8')
const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
for (const icon of ICONS) await render({ ...icon, source })
