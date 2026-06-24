import { describe, it, expect } from 'vitest'
import { clauseSuggest, applyClauseItem, insertAtCursor } from './clauseComplete'

const COLS = ['id', 'secucode', 'security_code', 'org_code']

describe('clauseSuggest', () => {
  it('空 token 返回全部列 + 关键字(列在前)', () => {
    const s = clauseSuggest('', 0, COLS, 'where')
    expect(s.start).toBe(0)
    expect(s.end).toBe(0)
    expect(s.items.slice(0, 4).map(i => i.label)).toEqual(COLS)
    expect(s.items.some(i => i.kind === 'keyword' && i.label === 'AND')).toBe(true)
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

  it('WHERE 模式给 AND/OR 等关键字,ORDER 模式给 ASC/DESC', () => {
    const w = clauseSuggest('', 0, COLS, 'where').items.filter(i => i.kind === 'keyword').map(i => i.label)
    expect(w).toContain('AND')
    expect(w).toContain('IS NULL')
    const o = clauseSuggest('', 0, COLS, 'order').items.filter(i => i.kind === 'keyword').map(i => i.label)
    expect(o).toEqual(['ASC', 'DESC'])
  })

  it('ORDER BY:输入 id 后补 ASC/DESC 不应混入 WHERE 关键字', () => {
    const o = clauseSuggest('id ', 3, COLS, 'order')
    // token 为空(光标在空格后)→ 全部列 + ASC/DESC,无 AND/OR
    expect(o.items.some(i => i.label === 'AND')).toBe(false)
    expect(o.items.some(i => i.label === 'ASC')).toBe(true)
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

describe('insertAtCursor', () => {
  it('在光标处插入文本(拖字段名),光标落在插入末尾', () => {
    const r = insertAtCursor('a = 1 AND ', 10, 'org_code')
    expect(r.value).toBe('a = 1 AND org_code')
    expect(r.cursor).toBe('a = 1 AND org_code'.length)
  })
})
