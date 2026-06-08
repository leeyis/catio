import type { Snippet } from '../services/types'

const KEY = 'catio-snippets'

export function loadSnippets(): Snippet[] {
  try {
    const r = localStorage.getItem(KEY)
    return r ? (JSON.parse(r) as Snippet[]) : []
  } catch {
    return []
  }
}

export function saveSnippet(s: Snippet): void {
  const l = loadSnippets().filter(x => x.id !== s.id)
  l.unshift(s)
  localStorage.setItem(KEY, JSON.stringify(l))
}

export function deleteSnippet(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadSnippets().filter(x => x.id !== id)))
}

let __n = 0
export function newSnippetId(): string {
  __n += 1
  return 's-' + Date.now().toString(36) + '-' + __n
}
