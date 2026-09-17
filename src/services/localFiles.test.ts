import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseLocalWorkspace, configureLocalWorkspace } from './localFiles'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.clearAllMocks() })
describe('local workspace transport', () => {
  it('does not pretend success or call server RPC outside Tauri', async () => {
    await expect(configureLocalWorkspace('/tmp')).rejects.toThrow('workspaceDesktopOnly')
    await expect(chooseLocalWorkspace()).rejects.toThrow('workspaceDesktopOnly')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('uses the native directory picker and sends only configuration to Rust', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    mocks.open.mockResolvedValue('/tmp/reports')
    expect(await chooseLocalWorkspace('/tmp')).toBe('/tmp/reports')
    expect(mocks.open).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: '/tmp' })
    mocks.invoke.mockResolvedValue('/tmp/reports')
    expect(await configureLocalWorkspace('/tmp/reports')).toBe('/tmp/reports')
    expect(mocks.invoke).toHaveBeenCalledWith('agent_set_workspace', { path: '/tmp/reports' })
  })
})
