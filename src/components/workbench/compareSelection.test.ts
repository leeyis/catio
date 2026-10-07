import { expect, it } from 'vitest'
import { computeDiff, genSyncStatements } from './compareTables'
import { compareChanges, selectedCompareDiff } from './compareSelection'

it('retains target values and both binary identities in source column order', () => {
  const diff = computeDiff({ srcColumns: ['id','value'], srcRows: [[1,'0xff']], srcBinaryCells: [[0,1]], tgtColumns: ['value','id'], tgtRows: [['0xff',1]], pkNames: ['id'] })
  const [change] = compareChanges(diff)
  expect(change.target).toEqual([1,'0xff'])
  expect(change.sourceBinary.has(1)).toBe(true)
  expect(change.targetBinary.has(1)).toBe(false)
  expect(change.changedColumns).toEqual([1])
})
it('reindexes binary cells after selecting a nonfirst row, preserving text hex and NULL', () => {
  const diff = computeDiff({ srcColumns: ['id','value'], srcRows: [[1,'0xaa'],[2,'0xff'],[3,null]], srcBinaryCells: [[1,1]], tgtColumns: ['id','value'], tgtRows: [], pkNames: ['id'] })
  const subset = selectedCompareDiff(diff, new Set(['inserts:1','inserts:2']), true)
  expect(subset.binary?.inserts).toEqual([[0,1]])
  const sql = genSyncStatements(subset,'','dst',{ engine:'sqlite', allowDelete:true })
  expect(sql).toHaveLength(2)
  expect(sql[0]).toContain("X'ff'")
  expect(sql[1]).toContain('NULL')
})
it('never re-enables deletes in a truncated comparison even with crafted selection IDs', () => {
  const diff = computeDiff({ srcColumns:['id'], srcRows:[], tgtColumns:['id'], tgtRows:[[1]], pkNames:['id'] })
  const subset = selectedCompareDiff(diff, new Set(['deletes:0','inserts:999']), false)
  expect(subset.deletes).toEqual([])
  expect(genSyncStatements(subset,'','dst',{ allowDelete:true })).toEqual([])
})
