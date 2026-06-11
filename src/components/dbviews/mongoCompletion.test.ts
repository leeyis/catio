import { describe, it, expect } from 'vitest'
import { mongoCompletionPlan } from './mongoCompletion'

const colls = ['users', 'orders', 'system.users']

describe('mongoCompletionPlan — collection context', () => {
  it('completes collection names right after "db."', () => {
    const plan = mongoCompletionPlan('db.', colls)
    expect(plan).not.toBeNull()
    expect(plan!.replaceLen).toBe(0)
    expect(plan!.options.map(o => o.label)).toEqual(expect.arrayContaining(['users', 'orders', 'system.users']))
  })

  it('filters collection names by the typed partial (dotted names included)', () => {
    const plan = mongoCompletionPlan('db.sys', colls)
    expect(plan!.replaceLen).toBe(3)
    expect(plan!.options.map(o => o.label)).toContain('system.users')
    expect(plan!.options.map(o => o.label)).not.toContain('orders')
  })
})

describe('mongoCompletionPlan — method context', () => {
  it('completes collection methods after "db.<coll>."', () => {
    const plan = mongoCompletionPlan('db.users.', colls)
    expect(plan!.replaceLen).toBe(0)
    const labels = plan!.options.map(o => o.label)
    expect(labels).toEqual(expect.arrayContaining(['find', 'countDocuments', 'aggregate', 'getIndexes']))
    // apply templates carry the call parens
    expect(plan!.options.find(o => o.label === 'find')!.apply).toContain('find(')
  })

  it('filters methods by partial and supports dotted collection names', () => {
    const plan = mongoCompletionPlan('db.system.users.cou', colls)
    expect(plan!.replaceLen).toBe(3)
    expect(plan!.options.map(o => o.label)).toEqual(['countDocuments', 'count'])
  })
})

describe('mongoCompletionPlan — chain context', () => {
  it('completes sort/skip/limit after a ")"', () => {
    const plan = mongoCompletionPlan('db.users.find({}).', colls)
    expect(plan!.replaceLen).toBe(0)
    expect(plan!.options.map(o => o.label)).toEqual(['sort', 'skip', 'limit'])
  })
})

describe('mongoCompletionPlan — no context', () => {
  it('returns null when the line is not a mongo expression', () => {
    expect(mongoCompletionPlan('select 1 from t', colls)).toBeNull()
  })

  it('returns null when an unknown collection has no method matches', () => {
    // "db.nope." → not a known collection, and no collection name matches "nope."
    expect(mongoCompletionPlan('db.nope.', colls)).toBeNull()
  })
})
