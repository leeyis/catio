import { beforeEach, describe, expect, it } from 'vitest'
import {
  addConnectionFavorite,
  loadConnectionFavorites,
  removeConnectionFavorite,
  toggleConnectionFavorite,
} from './connectionFavorites'

beforeEach(() => localStorage.clear())

describe('connectionFavorites', () => {
  it('persists only connection ids', () => {
    addConnectionFavorite('host-1')

    expect(loadConnectionFavorites()).toEqual(['host-1'])
    expect(localStorage.getItem('catio-connection-favorites')).toBe(JSON.stringify([{ id: 'host-1' }]))
  })

  it('toggles favorites without duplicating ids', () => {
    expect(toggleConnectionFavorite('db-1')).toBe(true)
    expect(toggleConnectionFavorite('db-1')).toBe(false)
    expect(loadConnectionFavorites()).toEqual([])

    addConnectionFavorite('db-1')
    addConnectionFavorite('db-1')
    expect(loadConnectionFavorites()).toEqual(['db-1'])

    removeConnectionFavorite('db-1')
    expect(loadConnectionFavorites()).toEqual([])
  })
})
