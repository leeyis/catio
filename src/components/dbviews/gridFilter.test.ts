import { describe, it, expect } from 'vitest'
import {
  filterModeNeedsValue,
  evalRule,
  filterRows,
  type FilterRule,
  type FilterMode,
} from './gridFilter'

// 列下标映射:测试用一个简单 3 列表(id:int / name:text / score:int)。
const cols = ['id', 'name', 'score']
const colIdx = (n: string) => cols.indexOf(n)

// 工具:构造一条规则(补默认 conjunction=AND / id)。
function rule(columnName: string, mode: FilterMode, rawValue = '', conjunction: 'AND' | 'OR' = 'AND'): FilterRule {
  return { id: `${columnName}-${mode}`, columnName, mode, rawValue, conjunction }
}

describe('filterModeNeedsValue', () => {
  it('value-bearing modes need a value', () => {
    const need: FilterMode[] = ['equals', 'not-equals', 'like', 'not-like', 'greater-than', 'less-than']
    for (const m of need) expect(filterModeNeedsValue(m)).toBe(true)
  })
  it('is-null / is-not-null take no value', () => {
    expect(filterModeNeedsValue('is-null')).toBe(false)
    expect(filterModeNeedsValue('is-not-null')).toBe(false)
  })
})

describe('evalRule — 8 operators', () => {
  const row = [1, 'alice', 90] // id=1 name=alice score=90

  it('equals (numeric-aware): "1" matches numeric 1; mismatch fails', () => {
    expect(evalRule(row, rule('id', 'equals', '1'), colIdx)).toBe(true)
    expect(evalRule(row, rule('id', 'equals', '2'), colIdx)).toBe(false)
  })
  it('equals on text is exact, case-sensitive', () => {
    expect(evalRule(row, rule('name', 'equals', 'alice'), colIdx)).toBe(true)
    expect(evalRule(row, rule('name', 'equals', 'Alice'), colIdx)).toBe(false)
  })
  it('not-equals is the negation of equals', () => {
    expect(evalRule(row, rule('name', 'not-equals', 'bob'), colIdx)).toBe(true)
    expect(evalRule(row, rule('name', 'not-equals', 'alice'), colIdx)).toBe(false)
  })
  it('like = case-insensitive substring contains', () => {
    expect(evalRule(row, rule('name', 'like', 'LIC'), colIdx)).toBe(true)
    expect(evalRule(row, rule('name', 'like', 'zzz'), colIdx)).toBe(false)
  })
  it('not-like = negation of contains', () => {
    expect(evalRule(row, rule('name', 'not-like', 'zzz'), colIdx)).toBe(true)
    expect(evalRule(row, rule('name', 'not-like', 'ali'), colIdx)).toBe(false)
  })
  it('greater-than / less-than compare numerically when both are numeric', () => {
    expect(evalRule(row, rule('score', 'greater-than', '80'), colIdx)).toBe(true)
    expect(evalRule(row, rule('score', 'greater-than', '90'), colIdx)).toBe(false)
    expect(evalRule(row, rule('score', 'less-than', '100'), colIdx)).toBe(true)
    expect(evalRule(row, rule('score', 'less-than', '90'), colIdx)).toBe(false)
  })
  it('greater-than / less-than fall back to string compare for non-numeric', () => {
    expect(evalRule(row, rule('name', 'greater-than', 'aaa'), colIdx)).toBe(true)
    expect(evalRule(row, rule('name', 'less-than', 'zzz'), colIdx)).toBe(true)
  })
  it('is-null / is-not-null on a non-null cell', () => {
    expect(evalRule(row, rule('name', 'is-null'), colIdx)).toBe(false)
    expect(evalRule(row, rule('name', 'is-not-null'), colIdx)).toBe(true)
  })
  it('is-null / is-not-null on a null cell', () => {
    const r = [1, null, 90]
    expect(evalRule(r, rule('name', 'is-null'), colIdx)).toBe(true)
    expect(evalRule(r, rule('name', 'is-not-null'), colIdx)).toBe(false)
  })
  it('empty-string cell is NOT treated as null', () => {
    const r = [1, '', 90]
    expect(evalRule(r, rule('name', 'is-null'), colIdx)).toBe(false)
    expect(evalRule(r, rule('name', 'is-not-null'), colIdx)).toBe(true)
  })
  it('unknown column → rule is ignored (treated as no-op true)', () => {
    expect(evalRule(row, rule('nope', 'equals', 'x'), colIdx)).toBe(true)
  })
})

describe('filterRows — AND/OR combination', () => {
  const rows: unknown[][] = [
    [1, 'alice', 90],
    [2, 'bob', 50],
    [3, 'carol', 75],
    [4, 'dave', 50],
  ]

  it('no rules → all rows kept', () => {
    expect(filterRows(rows, [], colIdx)).toEqual(rows)
  })

  it('blank value-bearing rule is skipped (no filtering)', () => {
    // equals with empty rawValue is incomplete → ignored, all rows kept.
    expect(filterRows(rows, [rule('name', 'equals', '')], colIdx)).toEqual(rows)
  })

  it('single rule filters', () => {
    expect(filterRows(rows, [rule('score', 'equals', '50')], colIdx)).toEqual([
      [2, 'bob', 50],
      [4, 'dave', 50],
    ])
  })

  it('two AND rules: both must hold', () => {
    const rules = [
      rule('score', 'equals', '50', 'AND'),
      rule('name', 'like', 'bob', 'AND'),
    ]
    expect(filterRows(rows, rules, colIdx)).toEqual([[2, 'bob', 50]])
  })

  it('two OR rules: either holds (conjunction taken from the SECOND rule)', () => {
    const rules = [
      rule('name', 'equals', 'alice', 'AND'),
      rule('name', 'equals', 'carol', 'OR'),
    ]
    expect(filterRows(rows, rules, colIdx)).toEqual([
      [1, 'alice', 90],
      [3, 'carol', 75],
    ])
  })

  it('left-to-right: A AND B OR C  ==  ((A AND B) OR C)', () => {
    // (score>70 AND name like 'a') OR (score=50)
    const rules = [
      rule('score', 'greater-than', '70', 'AND'),
      rule('name', 'like', 'a', 'AND'),
      rule('score', 'equals', '50', 'OR'),
    ]
    // score>70 AND name~a → alice(90), carol(75 has 'a'? no 'a' → carol='carol' has 'a') yes carol
    // → alice, carol ; OR score=50 → bob, dave
    expect(filterRows(rows, rules, colIdx)).toEqual([
      [1, 'alice', 90],
      [2, 'bob', 50],
      [3, 'carol', 75],
      [4, 'dave', 50],
    ])
  })

  it('incomplete rules in the middle are skipped without breaking the chain', () => {
    const rules = [
      rule('score', 'equals', '50', 'AND'),
      rule('name', 'equals', '', 'OR'), // incomplete → skipped
    ]
    expect(filterRows(rows, rules, colIdx)).toEqual([
      [2, 'bob', 50],
      [4, 'dave', 50],
    ])
  })
})
