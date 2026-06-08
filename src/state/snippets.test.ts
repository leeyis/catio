import { describe, it, expect, beforeEach } from 'vitest'
import { loadSnippets, saveSnippet, deleteSnippet, newSnippetId } from './snippets'

beforeEach(() => localStorage.clear())

describe('snippets store', () => {
  it('adds, updates by id, deletes', () => {
    saveSnippet({ id: 's1', scope: 'Shell', desc: 'a', icon: 'terminal', code: 'ls' })
    expect(loadSnippets()).toHaveLength(1)
    saveSnippet({ id: 's1', scope: 'Shell', desc: 'b', icon: 'terminal', code: 'ls -l' })
    expect(loadSnippets()).toHaveLength(1)
    expect(loadSnippets()[0].desc).toBe('b')
    deleteSnippet('s1')
    expect(loadSnippets()).toHaveLength(0)
  })

  it('newSnippetId is unique-ish', () => {
    expect(newSnippetId()).not.toBe(newSnippetId())
  })
})
