import { describe, it, expect } from 'vitest'
import {
  visibleColumnNames,
  allNullColumnNames,
  toggleColumnVisibility,
  showAllColumns,
} from './columnVisibility'

// 测试用 4 列表：id / name / note / extra。
const cols = ['id', 'name', 'note', 'extra']

describe('visibleColumnNames', () => {
  it('无隐藏偏好时返回全部列(顺序不变)', () => {
    expect(visibleColumnNames(cols, new Set())).toEqual(cols)
  })
  it('隐藏集合中的列被剔除,其余保持原顺序', () => {
    expect(visibleColumnNames(cols, new Set(['name', 'extra']))).toEqual(['id', 'note'])
  })
  it('隐藏不存在的列名不影响结果', () => {
    expect(visibleColumnNames(cols, new Set(['ghost']))).toEqual(cols)
  })
  it('防止隐藏到一列不剩:全部列都在隐藏集时回退为显示全部', () => {
    expect(visibleColumnNames(cols, new Set(cols))).toEqual(cols)
  })
})

describe('allNullColumnNames', () => {
  it('整列均为 null 的列被判定为全 NULL', () => {
    const rows: unknown[][] = [
      [1, 'a', null, null],
      [2, 'b', null, 'x'],
    ]
    // note 整列为 null;extra 第二行有值 → 仅 note。
    expect(allNullColumnNames(cols, rows)).toEqual(['note'])
  })
  it('多列全 NULL 时全部返回(保持列顺序)', () => {
    const rows: unknown[][] = [
      [1, null, null, 'x'],
      [2, null, null, 'y'],
    ]
    expect(allNullColumnNames(cols, rows)).toEqual(['name', 'note'])
  })
  it('空结果集不判定任何列为全 NULL', () => {
    expect(allNullColumnNames(cols, [])).toEqual([])
  })
  it('undefined 与 null 同等视为空值', () => {
    const rows: unknown[][] = [[1, 'a', undefined, 0]]
    expect(allNullColumnNames(cols, rows)).toEqual(['note'])
  })
})

describe('toggleColumnVisibility', () => {
  it('未隐藏的列被加入隐藏集', () => {
    const next = toggleColumnVisibility(cols, new Set(), 'name')
    expect([...next]).toEqual(['name'])
  })
  it('已隐藏的列被移出隐藏集(再次切换=显示)', () => {
    const next = toggleColumnVisibility(cols, new Set(['name']), 'name')
    expect(next.size).toBe(0)
  })
  it('不允许隐藏最后一列可见列', () => {
    // 已隐藏 3 列,仅剩 extra 可见;尝试隐藏 extra 应被拒绝。
    const hidden = new Set(['id', 'name', 'note'])
    const next = toggleColumnVisibility(cols, hidden, 'extra')
    expect(next.has('extra')).toBe(false)
    expect(next.size).toBe(3)
  })
})

describe('showAllColumns', () => {
  it('返回空隐藏集(全部显示)', () => {
    expect(showAllColumns().size).toBe(0)
  })
})
