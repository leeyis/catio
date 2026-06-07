import { describe, it, expect } from 'vitest'
import { DATA } from '../src/services/mockData'
describe('mockData', () => {
  it('has 13 connections and byId index', () => {
    expect(DATA.connections.length).toBe(13)
    expect(DATA.byId['d-orders'].engine).toBe('postgres')
  })
  it('orders rows are 120', () => { expect(DATA.ordersRows.length).toBe(120) })
})
