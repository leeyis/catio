import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  isServer: vi.fn(() => true),
  rpc: vi.fn(),
}))

vi.mock('./transport', () => ({
  isServer: h.isServer,
  rpc: h.rpc,
}))

import { clearUserStores, storeLoad, storeUpsertPersisted } from './userStore'

interface TestItem {
  id: string
  name: string
}

describe('storeUpsertPersisted', () => {
  beforeEach(() => {
    clearUserStores()
    h.isServer.mockReturnValue(true)
    h.rpc.mockReset()
  })

  it('does not expose a server item in memory when persistence fails', async () => {
    h.rpc.mockRejectedValue(new Error('store unavailable'))

    await expect(storeUpsertPersisted<TestItem>('test-store', 'test-key', { id: 'item-1', name: 'API' }))
      .rejects.toThrow('store unavailable')
    expect(storeLoad<TestItem>('test-store', 'test-key')).toEqual([])
  })

  it('updates the server cache only after persistence succeeds', async () => {
    let resolveWrite: () => void = () => {}
    h.rpc.mockReturnValue(new Promise<void>(resolve => { resolveWrite = resolve }))

    const pending = storeUpsertPersisted<TestItem>('test-store', 'test-key', { id: 'item-1', name: 'API' })
    expect(storeLoad<TestItem>('test-store', 'test-key')).toEqual([])

    resolveWrite()
    await pending
    expect(storeLoad<TestItem>('test-store', 'test-key')).toEqual([{ id: 'item-1', name: 'API' }])
  })
})
