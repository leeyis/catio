import { describe, it, expect } from 'vitest'
import { planHistoryCompletion, type ShellHistoryEntry } from './historyCompletion'

const entries: ShellHistoryEntry[] = [
  { text: 'git status', ts: 100 },
  { text: 'git stash', ts: 200 },
  { text: 'git commit -m "x"', ts: 50 },
  { text: 'cd /var/git', ts: 300 }, // 子串命中 "git" 但非前缀
]

describe('planHistoryCompletion — 基本行为', () => {
  it('空输入返回空', () => {
    const r = planHistoryCompletion('', entries)
    expect(r.items).toEqual([])
    expect(r.ghost).toBeNull()
  })

  it('无匹配返回空', () => {
    const r = planHistoryCompletion('zzz', entries)
    expect(r.items).toEqual([])
    expect(r.ghost).toBeNull()
  })

  it('前缀命中排在子串命中之前', () => {
    const r = planHistoryCompletion('git', entries)
    const texts = r.items.map(i => i.text)
    // 前三条为前缀命中(以 git 开头),最后是子串命中 "cd /var/git"
    expect(texts.slice(0, 3).every(t => t.startsWith('git'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('cd /var/git')
  })

  it('组内按 ts 降序(最近优先)', () => {
    const r = planHistoryCompletion('git', entries)
    const prefixTexts = r.items.filter(i => i.text.startsWith('git')).map(i => i.text)
    expect(prefixTexts).toEqual(['git stash', 'git status', 'git commit -m "x"'])
  })
})

describe('planHistoryCompletion — 去重', () => {
  it('同一 text 去重并保留 ts 最大的一条', () => {
    const dup: ShellHistoryEntry[] = [
      { text: 'npm run dev', ts: 10 },
      { text: 'npm run dev', ts: 999 },
      { text: 'npm run dev', ts: 500 },
    ]
    const r = planHistoryCompletion('npm', dup)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toEqual({ text: 'npm run dev', ts: 999 })
  })
})

describe('planHistoryCompletion — 大小写与匹配', () => {
  it('匹配忽略大小写', () => {
    const r = planHistoryCompletion('GIT', entries)
    expect(r.items.length).toBeGreaterThan(0)
    expect(r.items.some(i => i.text === 'git stash')).toBe(true)
  })

  it('排除 text === input 的项', () => {
    const data: ShellHistoryEntry[] = [
      { text: 'ls', ts: 100 },
      { text: 'ls -la', ts: 50 },
    ]
    const r = planHistoryCompletion('ls', data)
    expect(r.items.map(i => i.text)).toEqual(['ls -la'])
  })
})

describe('planHistoryCompletion — ghost', () => {
  it('严格大小写前缀命中时给出剩余串', () => {
    const r = planHistoryCompletion('git st', entries)
    // items[0] 为最近的前缀命中 "git stash"
    expect(r.items[0].text).toBe('git stash')
    expect(r.ghost).toBe('ash')
  })

  it('大小写不符时 ghost 为 null', () => {
    const data: ShellHistoryEntry[] = [{ text: 'Git push', ts: 100 }]
    const r = planHistoryCompletion('git', data)
    // 忽略大小写命中,进入 items,但非严格大小写前缀 → ghost 为 null
    expect(r.items[0].text).toBe('Git push')
    expect(r.ghost).toBeNull()
  })

  it('items[0] 为子串命中(非前缀)时 ghost 为 null', () => {
    const data: ShellHistoryEntry[] = [{ text: 'cd /var/git', ts: 100 }]
    const r = planHistoryCompletion('git', data)
    expect(r.items[0].text).toBe('cd /var/git')
    expect(r.ghost).toBeNull()
  })
})

describe('planHistoryCompletion — limit 截断', () => {
  it('opts.limit 截断 items', () => {
    const many: ShellHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      text: `cmd${i}`,
      ts: i,
    }))
    const r = planHistoryCompletion('cmd', many, { limit: 3 })
    expect(r.items).toHaveLength(3)
    // 最近优先,ts 9/8/7
    expect(r.items.map(i => i.text)).toEqual(['cmd9', 'cmd8', 'cmd7'])
  })

  it('默认 limit 为 50', () => {
    const many: ShellHistoryEntry[] = Array.from({ length: 60 }, (_, i) => ({
      text: `cmd${i}`,
      ts: i,
    }))
    const r = planHistoryCompletion('cmd', many)
    expect(r.items).toHaveLength(50)
  })
})
