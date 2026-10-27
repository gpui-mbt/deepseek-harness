/** Keyless Chromium + shipped Host acceptance; not a real-provider OAuth login. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vite-plus/test'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm-chatgpt'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: in-box ChatGPT settings (isolated fake account)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const externalRequests: string[] = []
  const evidenceDir = fileURLToPath(new URL('../../../.artifacts/chatgpt-ci/', import.meta.url))

  beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true })
    await rm(join(evidenceDir, 'browser-started.json'), { force: true })
    const realFetch = globalThis.fetch
    // Intercept ONLY the provider boundary; Host RPC and asset delivery remain real.
    // Unknown provider requests fail closed, so fixture tokens cannot leave this process.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'api.openai.com' || url.hostname === 'auth.openai.com') {
        externalRequests.push(url.href)
        if (url.href === 'https://api.openai.com/v1/models') {
          return Response.json({ models: [{ slug: 'fixture-browser-model', display_name: 'Browser fixture model', visibility: 'list' }] })
        }
        // Deliberately exercise unconfirmed revocation: local sign-out must still erase secrets.
        if (url.href === 'https://auth.openai.com/.well-known/openid-configuration') return new Response('', { status: 503 })
        throw new Error(`Unexpected provider boundary request: ${url.origin}${url.pathname}`)
      }
      return realFetch(input, init)
    })
    scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    const executablePath = process.env.DSH_WEB_E2E_CHROMIUM_EXECUTABLE
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    await page.context().route('https://auth.openai.com/**', async route => {
      await route.fulfill({ contentType: 'text/html', body: '<title>Isolated OAuth fixture</title><p>No provider login is performed.</p>' })
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  async function openChatGpt(): Promise<void> {
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    while (await panel.getByRole('button', { name: /^Back/ }).count()) await panel.getByRole('button', { name: /^Back/ }).first().click()
    await panel.getByRole('button', { name: 'View ChatGPT', exact: true }).click()
    await page.getByRole('heading', { name: 'Accounts', exact: true }).waitFor()
  }

  it('records Chromium close policy with a minimal opener-isolated cross-origin control', async () => {
    const context = await browser.newContext()
    const warnings: string[] = []
    const outcomes: { isolated: boolean; closeAccepted: boolean; closed: boolean; openerNull: boolean }[] = []
    try {
      await context.route('https://popup-origin.invalid/**', route =>
        route.fulfill({ contentType: 'text/html', body: '<button id="open">Open fixture</button>' }),
      )
      await context.route('https://popup-provider.invalid/**', route =>
        route.fulfill({ contentType: 'text/html', body: '<p>Inert fixture</p>' }),
      )
      for (const isolated of [false, true]) {
        const origin = await context.newPage()
        origin.on('console', message => {
          if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
        })
        await origin.goto('https://popup-origin.invalid/')
        await origin.evaluate(isolated => {
          document.querySelector('button')!.onclick = () => {
            const popup = window.open('about:blank', '_blank')!
            if (isolated) popup.opener = null
            Object.assign(window, { fixturePopup: popup })
            popup.location.replace('https://popup-provider.invalid/')
          }
        }, isolated)
        const opened = origin.waitForEvent('popup')
        await origin.getByRole('button', { name: 'Open fixture' }).click()
        const popup = await opened
        await popup.waitForURL('https://popup-provider.invalid/')
        const openerNull = await popup.evaluate(() => window.opener === null)
        expect(openerNull).toBe(isolated)
        const closeAccepted = await origin.evaluate(() => {
          const fixtureWindow: typeof window & { fixturePopup?: Window } = window
          const popup = fixtureWindow.fixturePopup
          if (popup === undefined) throw new Error('The fixture did not retain its popup')
          popup.close()
          return popup.closed
        })
        expect(closeAccepted).toBe(!isolated)
        if (!isolated) await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true)
        else {
          // The fixture has no product busy state, attempt map or React lifecycle.
          // This negative control distinguishes browser policy from a product race.
          // Chromium sets WindowProxy.closed synchronously when close is accepted;
          // the returned false above is not a short-delay timing inference.
          expect(popup.isClosed()).toBe(false)
        }
        outcomes.push({ isolated, closeAccepted, closed: popup.isClosed(), openerNull })
        if (!popup.isClosed()) await popup.close()
        await origin.close()
      }
    } finally {
      await writeFile(join(evidenceDir, 'popup-policy.json'), JSON.stringify({ browser: browser.version(), outcomes, warnings }, null, 2))
      await context.close()
    }
  })

  it('cancels repeated real Host callback flows, persists model settings, and clears local credentials on sign-out', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-chatgpt-settings'))
    await writeFile(
      join(evidenceDir, 'browser-started.json'),
      JSON.stringify({ browser: browser.version(), scope: 'keyless isolated fixture', startedAt: new Date().toISOString() }),
    )
    await openChatGpt()
    await page.getByText('No ChatGPT account is connected yet.', { exact: true }).waitFor()
    const states = new Set<string>()
    for (let index = 0; index < 2; index++) {
      const popupPromise = page.waitForEvent('popup')
      await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
      const popup = await popupPromise
      await popup.waitForURL('https://auth.openai.com/**')
      expect(await popup.evaluate(() => window.opener === null)).toBe(true)
      const authorize = new URL(popup.url())
      expect(authorize.pathname).toBe('/api/accounts/authorize')
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorize.searchParams.get('code_challenge')).toBeTruthy()
      expect(authorize.searchParams.get('state')).toBeTruthy()
      states.add(authorize.searchParams.get('state')!)
      await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
      await expect
        .poll(async () => (await scaffold.ctx.chatgptController.getState()).loginAttempts.every(attempt => attempt.phase === 'cancelled'), {
          timeout: 10_000,
        })
        .toBe(true)
      await expect
        .poll(() => page.getByText('Sign-in cancelled. If the browser sign-in tab is still open, close it.', { exact: true }).count(), {
          timeout: 10_000,
        })
        .toBe(index + 1)
      expect((await scaffold.ctx.chatgptController.getState()).accounts).toEqual([])
      const callback = new URL(authorize.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', authorize.searchParams.get('state')!)
      callback.searchParams.set('error', 'access_denied')
      // An actual late OS HTTP delivery must fail because cancellation closed the listener.
      await expect
        .poll(
          async () => {
            try {
              await fetch(callback, { signal: AbortSignal.timeout(2_000) })
              return 'listener-still-open'
            } catch (error) {
              return (error as { cause?: { code?: string } }).cause?.code
            }
          },
          { timeout: 10_000 },
        )
        .toBe('ECONNREFUSED')
      expect((await scaffold.ctx.chatgptController.getState()).accounts).toEqual([])
      // Harness cleanup only AFTER the security assertions. Browser policy may retain
      // the disowned provider tab; product copy explicitly asks the user to close it.
      if (!popup.isClosed()) {
        expect(await popup.evaluate(() => window.opener === null)).toBe(true)
        await popup.close()
      }
    }
    expect(states.size).toBe(2)

    const accountId = 'account-00000000-0000-4000-8000-000000000001' as Parameters<
      typeof scaffold.ctx.chatgptController.setActiveAccount
    >[0]['accountId']
    const key = credentialKey('dsh-chatgpt', String(accountId))
    await scaffold.ctx.credentials.modifyRecord(key, async () => ({
      kind: 'grant',
      payload: {
        version: 1,
        accountId,
        clientId: 'fixture-client',
        subject: 'fixture-subject',
        email: 'browser@example.invalid',
        grantGeneration: 0,
        accessToken: 'fixture-access-not-a-secret',
        refreshToken: 'fixture-refresh-not-a-secret',
        idToken: 'fixture-id-not-a-secret',
        expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(),
        status: 'connected',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      },
    }))
    await scaffold.ctx.chatgptController.setActiveAccount({ accountId })
    // Welcome is acknowledged through the UI, not a mocked remote method.
    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await openChatGpt()
    await page.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.chatgptController.getState()).welcomeAcknowledged, { timeout: 10_000 }).toBe(true)
    await expect.poll(() => page.getByLabel('Active account', { exact: true }).inputValue(), { timeout: 10_000 }).toBe(String(accountId))
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click()
    await page.locator('summary').filter({ hasText: 'Browser fixture model' }).click()
    await page.getByLabel('Context window (tokens)', { exact: true }).fill('32768')
    await page.getByRole('button', { name: 'Save model settings', exact: true }).click()
    await page.getByText('Model settings saved.', { exact: true }).waitFor()
    const patch = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    await expect.poll(async () => readFile(patch, 'utf8'), { timeout: 10_000 }).toContain('32768')
    await page.reload({ waitUntil: 'load' })
    await openChatGpt()
    await page.locator('summary').filter({ hasText: 'Browser fixture model' }).click()
    await expect.poll(() => page.getByLabel('Context window (tokens)', { exact: true }).inputValue(), { timeout: 10_000 }).toBe('32768')
    await expect.poll(() => page.getByLabel('Active account', { exact: true }).inputValue(), { timeout: 10_000 }).toBe(String(accountId))
    expect(await page.getByRole('button', { name: 'Got it', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    const connectedRecord = await scaffold.ctx.credentials.readRecord(key)
    if (connectedRecord?.kind !== 'grant') throw new Error('Expected isolated fixture grant')
    expect(connectedRecord.payload).toHaveProperty('accessToken')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByText('You signed out locally, but OpenAI did not confirm token revocation.', { exact: true }).waitFor()
    const record = await scaffold.ctx.credentials.readRecord(key)
    if (record?.kind !== 'grant') throw new Error('Expected retained account registration')
    expect(record.payload).toMatchObject({ status: 'needs-sign-in' })
    expect(record.payload).not.toHaveProperty('accessToken')
    expect(record.payload).not.toHaveProperty('refreshToken')
    expect(record.payload).not.toHaveProperty('idToken')
    expect(externalRequests).toContain('https://api.openai.com/v1/models')
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await page.screenshot({ path: join(evidenceDir, 'browser-settings.png'), fullPage: true })
  })
})
