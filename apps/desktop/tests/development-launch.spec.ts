import { describe, expect, it } from 'vite-plus/test'
import { electronDevelopmentArguments } from '../scripts/dev.ts'

const base = {
  mainPort: 9229,
  rendererPort: 9222,
  userData: '/tmp/user-data',
  appRoot: '/app',
}

describe('desktop development launch', () => {
  it('disables the Chromium sandbox on Linux unless the host opts in', () => {
    expect(electronDevelopmentArguments({ ...base, platform: 'linux' })).toContain('--no-sandbox')
    expect(electronDevelopmentArguments({ ...base, platform: 'linux', sandbox: '0' })).toContain('--no-sandbox')
    expect(electronDevelopmentArguments({ ...base, platform: 'linux', sandbox: '1' })).not.toContain('--no-sandbox')
  })

  it('keeps the platform sandbox on macOS and Windows', () => {
    expect(electronDevelopmentArguments({ ...base, platform: 'darwin' })).not.toContain('--no-sandbox')
    expect(electronDevelopmentArguments({ ...base, platform: 'win32' })).not.toContain('--no-sandbox')
  })

  it('passes the inspection ports, browser data, and application root', () => {
    expect(electronDevelopmentArguments({ ...base, platform: 'linux', sandbox: '1' })).toEqual([
      '--inspect=127.0.0.1:9229',
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/user-data',
      '/app',
    ])
  })
})
