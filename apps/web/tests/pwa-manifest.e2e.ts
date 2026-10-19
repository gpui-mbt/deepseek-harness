import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  // `standalone` keeps the installed window on the app's own chrome; `fullscreen`
  // would hide the status bar the safe-area padding is measured against.
  expect(manifest).toEqual({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      {
        src: 'favicon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: 'icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: 'icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  })
  for (const file of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) {
    // The PNGs are the icon sources themselves, not placeholders: a missing
    // file or an SVG echoed under a .png name would both fail here.
    expect((await readFile(join(DIST_ROOT, file))).subarray(1, 4).toString(), `${file} is not a PNG`).toBe('PNG')
  }
})

it('ships the iOS home-screen install metadata', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  // iOS ignores the manifest's icon list and display mode: the touch icon and
  // the capable/title metas are what make the home-screen entry launch without
  // Safari's chrome.
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
  expect(index).toContain('<meta name="mobile-web-app-capable" content="yes" />')
  expect(index).toContain('<meta name="apple-mobile-web-app-title" content="DSH" />')
  expect(index).toContain('viewport-fit=cover')
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#000"')
  expect(dark).toContain('fill="#fff"')
  expect(dark.replace('fill="#fff"', 'fill="#000"')).toBe(light)
})
