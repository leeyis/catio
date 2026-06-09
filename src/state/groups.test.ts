import { describe, it, expect, beforeEach } from 'vitest'
import { loadGroups, addGroup, renameGroup, removeGroup } from './groups'

beforeEach(() => localStorage.clear())

describe('groups store', () => {
  it('starts empty', () => {
    expect(loadGroups()).toEqual([])
  })

  it('adds a group with a generated id and palette colour', () => {
    const g = addGroup('Production')
    expect(g.id).toMatch(/^g-/)
    expect(g.name).toBe('Production')
    expect(g.color).toBeTruthy()
    expect(loadGroups()).toHaveLength(1)
  })

  it('renames and removes by id', () => {
    const g = addGroup('Staging')
    renameGroup(g.id, 'Stg')
    expect(loadGroups()[0].name).toBe('Stg')
    removeGroup(g.id)
    expect(loadGroups()).toEqual([])
  })

  it('falls back to a default name for blank input', () => {
    const g = addGroup('   ')
    expect(g.name).toBe('New group')
  })
})
