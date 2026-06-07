import { describe, it, expect } from 'vitest'
import * as svc from '../src/services'
describe('services seam', () => {
  it('listConnections returns the vault', async () => {
    const c = await svc.listConnections()
    expect(c.find(x => x.id === 'd-orders')).toBeTruthy()
  })
  it('runQuery returns rows + columns', async () => {
    const r = await svc.runQuery('d-orders', 'select 1')
    expect(r.columns.length).toBeGreaterThan(0)
    expect(Array.isArray(r.rows)).toBe(true)
  })
})
