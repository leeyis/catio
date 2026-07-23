// Per-host Catio Agent conversation persistence (localStorage).
// Conversations are scoped by `hostKey` (the workbench tab's connId) so the
// history list follows the active tab's host. Messages stream live in App state
// and are persisted here (upsert by id).

export interface ConvMessage {
  role: 'user' | 'assistant'
  content: string
}

import { storeLoad, storeUpsert, storeRemove, type StoreItem } from '../services/userStore'

export interface Conversation extends StoreItem {
  id: string
  hostKey: string
  title: string
  messages: ConvMessage[]
  createdAt: number
  updatedAt: number
}

const STORE = 'conversations'
const KEY = 'catio-conversations'

function hasContent(c: Conversation): boolean {
  return Array.isArray(c.messages)
    && c.messages.some(message => typeof message.content === 'string' && message.content.trim().length > 0)
}

/** Trim/normalize a derived title from the first user message. */
function deriveTitle(messages: ConvMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser) return ''
  const text = firstUser.content.trim().replace(/\s+/g, ' ')
  return text.length > 40 ? text.slice(0, 40) + '…' : text
}

export function loadConversations(): Conversation[] {
  return storeLoad<Conversation>(STORE, KEY).filter(hasContent)
}

// Monotonic clock: guarantees strictly-increasing updatedAt even for multiple
// saves within the same millisecond, so newest-first ordering is deterministic.
let __lastTs = 0
function nextTimestamp(): number {
  const now = Date.now()
  __lastTs = now > __lastTs ? now : __lastTs + 1
  return __lastTs
}

/**
 * Upsert a conversation by id. Sets `updatedAt` and, when the stored title is
 * empty, derives one from the first user message. Empty drafts are not persisted.
 */
export function saveConversation(c: Conversation): void {
  if (!hasContent(c)) return
  storeUpsert(STORE, KEY, {
    ...c,
    title: c.title || deriveTitle(c.messages),
    updatedAt: nextTimestamp(),
  })
}

export function deleteConversation(id: string, ownerId?: number): void {
  storeRemove<Conversation>(STORE, KEY, id, ownerId)
}

/** Conversations for a host, newest-updated first. */
export function conversationsForHost(hostKey: string): Conversation[] {
  return loadConversations()
    .filter(c => c.hostKey === hostKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

let __n = 0
export function newConversationId(): string {
  __n += 1
  return 'conv-' + Date.now().toString(36) + '-' + __n
}

/** A fresh, empty conversation for a host (not yet persisted). */
export function newConversation(hostKey: string): Conversation {
  const now = Date.now()
  return {
    id: newConversationId(),
    hostKey,
    title: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}
