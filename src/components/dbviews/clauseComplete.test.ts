import { describe, it, expect } from 'vitest'
import { clauseSuggest, applyClauseItem } from './clauseComplete'

const COLS = ['id', 'secucode', 'security_code', 'org_code']

describe('clauseSuggest', () => {
  it('空 token(聚焦/操作符后)不返回候选 —— 不弹挂框', () => {
    expect(clauseSuggest('', 0, COLS, 'where').items).toEqual([])
    // org_code= 后光标处 token 为空 → 不弹(真机反馈)。
    expect(clauseSuggest('org_code=', 9, COLS, 'where').items).toEqual([])
  })

  it('按前缀过滤列名(大小写不敏感),并给出 token 替换区间', () => {
    const value = 'sec'
    const s = clauseSuggest(value, 3, COLS, 'where')
    expect(s.start).toBe(0)
    expect(s.end).toBe(3)
    expect(s.items.map(i => i.label)).toEqual(['secucode', 'security_code'])
  })

  it('只取光标处的 token(前面已完成的片段不参与)', () => {
    const value = "org_code = 1 AND sec"
    const s = clauseSuggest(value, value.length, COLS, 'where')
    expect(value.slice(s.start, s.end)).toBe('sec')
    expect(s.items.map(i => i.label)).toEqual(['secucode', 'security_code'])
  })

  it('token 恰好等于某候选时不再列出它(已选中/已打全 → 关闭该候选)', () => {
    const s = clauseSuggest('secucode', 8, ['secucode', 'security_code'], 'where')
    expect(s.items.some(i => i.label === 'secucode')).toBe(false)
    // security_code 不以 secucode 为前缀,故列表为空 → UI 不再弹候选。
    expect(s.items.filter(i => i.kind === 'column')).toEqual([])
  })

  it('完全匹配被剔除,但以其为前缀的更长候选仍保留', () => {
    const s = clauseSuggest('code', 4, ['code', 'code_x'], 'where')
    expect(s.items.map(i => i.label)).toEqual(['code_x'])
  })

  it('输入前缀匹配关键字:WHERE 给 AND,ORDER 给 ASC,互不混入', () => {
    // 输入 'a' → WHERE 匹配 AND(列里无以 a 开头者);ORDER 匹配 ASC。
    const w = clauseSuggest('org_code = 1 a', 14, COLS, 'where').items.map(i => i.label)
    expect(w).toContain('AND')
    expect(w).not.toContain('ASC')
    const o = clauseSuggest('id a', 4, COLS, 'order').items.map(i => i.label)
    expect(o).toContain('ASC')
    expect(o).not.toContain('AND')
  })
})

describe('applyClauseItem', () => {
  it('用候选替换光标处 token,光标移到插入末尾', () => {
    const value = 'org_code = 1 AND sec'
    const sug = clauseSuggest(value, value.length, COLS, 'where')
    const r = applyClauseItem(value, sug, { label: 'security_code', insert: 'security_code', kind: 'column' })
    expect(r.value).toBe('org_code = 1 AND security_code')
    expect(r.cursor).toBe(r.value.length)
  })

  it('替换发生在中间 token 时保留其后文本', () => {
    const value = 'sec = 1'
    const sug = clauseSuggest(value, 3, COLS, 'where')
    const r = applyClauseItem(value, sug, { label: 'secucode', insert: 'secucode', kind: 'column' })
    expect(r.value).toBe('secucode = 1')
    expect(r.cursor).toBe('secucode'.length)
  })
})
