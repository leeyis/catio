import type { Snippet } from '../services/types'
import { storeLoad, storeUpsert, storeRemove } from '../services/userStore'

const STORE = 'snippets'
const KEY = 'catio-snippets'

export function loadSnippets(): Snippet[] {
  return storeLoad<Snippet>(STORE, KEY)
}

export function saveSnippet(s: Snippet): void {
  storeUpsert(STORE, KEY, s)
}

export function deleteSnippet(id: string, ownerId?: number): void {
  storeRemove<Snippet>(STORE, KEY, id, ownerId)
}

let __n = 0
export function newSnippetId(): string {
  __n += 1
  return 's-' + Date.now().toString(36) + '-' + __n
}
