import { afterEach, expect, it, vi } from 'vitest'
import { installationSettings } from './installation'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  delete (window as unknown as Record<string, unknown>).__CATIO_SERVER__
  vi.restoreAllMocks()
  invoke.mockReset()
})

it('hides the repository in a standalone browser', async () => {
  expect(await installationSettings()).toEqual({ showRepository: false })
  expect(invoke).not.toHaveBeenCalled()
})

it('reads desktop installation settings through Tauri', async () => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  invoke.mockResolvedValue({ showRepository: true })
  expect(await installationSettings()).toEqual({ showRepository: true })
  expect(invoke).toHaveBeenCalledWith('installation_settings', undefined)
})

it('reads server installation settings through the authenticated transport', async () => {
  ;(window as unknown as Record<string, unknown>).__CATIO_SERVER__ = true
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"showRepository":true}'))
  expect(await installationSettings()).toEqual({ showRepository: true })
  expect(fetch).toHaveBeenCalledWith('/api/invoke', expect.objectContaining({
    credentials: 'include', body: JSON.stringify({ cmd: 'installation_settings', args: {} }),
  }))
})
