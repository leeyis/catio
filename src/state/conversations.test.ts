import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadConversations,
  saveConversation,
  deleteConversation,
  conversationsForHost,
  newConversation,
} from './conversations'

beforeEach(() => localStorage.clear())

describe('conversations store', () => {
  it('creates a fresh empty conversation for a host', () => {
    const c = newConversation('host-a')
    expect(c.hostKey).toBe('host-a')
    expect(c.messages).toEqual([])
    expect(c.title).toBe('')
    expect(c.id).toBeTruthy()
    // Not persisted until saved.
    expect(loadConversations()).toEqual([])
  })

  it('generates unique ids', () => {
    const a = newConversation('host-a')
    const b = newConversation('host-a')
    expect(a.id).not.toBe(b.id)
  })

  it('does not persist conversations without meaningful messages', () => {
    const c = newConversation('host-a')
    saveConversation(c)
    c.messages.push({ role: 'user', content: '   ' }, { role: 'assistant', content: '' })
    saveConversation(c)

    expect(loadConversations()).toEqual([])
    expect(localStorage.getItem('catio-conversations')).toBeNull()
  })

  it('filters empty conversations created by older versions', () => {
    const empty = newConversation('host-a')
    const whitespace = newConversation('host-a')
    whitespace.messages.push({ role: 'assistant', content: '  ' })
    const valid = newConversation('host-a')
    valid.messages.push({ role: 'user', content: 'keep this conversation' })
    localStorage.setItem('catio-conversations', JSON.stringify([empty, whitespace, valid]))

    expect(loadConversations().map(c => c.id)).toEqual([valid.id])
    expect(conversationsForHost('host-a').map(c => c.id)).toEqual([valid.id])
  })

  it('upserts by id and persists', () => {
    const c = newConversation('host-a')
    c.messages.push({ role: 'user', content: 'hello' })
    saveConversation(c)
    expect(loadConversations()).toHaveLength(1)

    // Update same id → still one row, with new content.
    c.messages.push({ role: 'assistant', content: 'hi there' })
    saveConversation(c)
    const list = loadConversations()
    expect(list).toHaveLength(1)
    expect(list[0].messages).toHaveLength(2)
  })

  it('derives the title from the first user message when empty', () => {
    const c = newConversation('host-a')
    c.messages.push({ role: 'user', content: '  list all running services please  ' })
    saveConversation(c)
    expect(loadConversations()[0].title).toBe('list all running services please')
  })

  it('truncates a long derived title to ~40 chars', () => {
    const long = 'a'.repeat(80)
    const c = newConversation('host-a')
    c.messages.push({ role: 'user', content: long })
    saveConversation(c)
    const title = loadConversations()[0].title
    expect(title.length).toBeLessThanOrEqual(41) // 40 + ellipsis
    expect(title.endsWith('…')).toBe(true)
  })

  it('keeps an explicit title over the derived one', () => {
    const c = newConversation('host-a')
    c.title = 'Custom title'
    c.messages.push({ role: 'user', content: 'whatever' })
    saveConversation(c)
    expect(loadConversations()[0].title).toBe('Custom title')
  })

  it('lists conversations by host, newest-updated first', () => {
    const a = newConversation('host-a')
    a.messages.push({ role: 'user', content: 'first' })
    saveConversation(a)
    const b = newConversation('host-b')
    b.messages.push({ role: 'user', content: 'other host' })
    saveConversation(b)
    const a2 = newConversation('host-a')
    a2.messages.push({ role: 'user', content: 'second' })
    saveConversation(a2)

    const forA = conversationsForHost('host-a')
    expect(forA).toHaveLength(2)
    // a2 saved last → newest first
    expect(forA[0].id).toBe(a2.id)
    expect(forA[1].id).toBe(a.id)

    expect(conversationsForHost('host-b')).toHaveLength(1)
    expect(conversationsForHost('nope')).toEqual([])
  })

  it('deletes a conversation by id', () => {
    const a = newConversation('host-a')
    a.messages.push({ role: 'user', content: 'first' })
    saveConversation(a)
    const b = newConversation('host-a')
    b.messages.push({ role: 'user', content: 'second' })
    saveConversation(b)
    deleteConversation(a.id)
    const list = loadConversations()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(b.id)
  })
})
