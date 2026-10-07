import { beforeEach, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ResultInsights } from './ResultInsights'
import { INSIGHT_ROW_LIMIT, profileResult, resultFrequencies } from './resultInsightAnalysis'
import type { QueryResult } from '../../services/types'
import i18n from '../../i18n'
const result: QueryResult = { columns:[{ name:'id',type:'int' },{ name:'value',type:'any' }], rows:[[1,'0xff'],[2,'0xff'],[3,null],[4,''],[5,1],[6,'9007199254740993']], binaryCells:[[0,1]], truncated:true }
beforeEach(async () => { await i18n.changeLanguage('en') })
it('profiles only actual finite numbers and preserves binary/text/NULL/empty distinctions', () => {
  expect(profileResult(result)[1]).toMatchObject({ nulls:1, empty:1, binary:1, numbers:1, min:1, max:1 })
  const chart = resultFrequencies({rows:[[1],['1'],[null],['NULL'],['0xff'],['0xff']],binaryCells:[[4,0]]},0)
  expect(chart.skipped).toBe(1)
  expect(chart.items.map(item => item.label)).toEqual(expect.arrayContaining(['1','"1"','NULL','"NULL"','"0xff"']))
  const rows = Array.from({length:INSIGHT_ROW_LIMIT + 1},(_,i) => [i])
  expect(profileResult({ columns:[{name:'value',type:'int'}], rows })[0].max).toBe(INSIGHT_ROW_LIMIT - 1)
})
it('shows scope, renders transposed typed values and switches to an accessible frequency chart', () => {
  render(<ResultInsights result={result}/>)
  expect(screen.getByText(/not whole-table statistics/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Transpose'}))
  expect(screen.getByRole('columnheader',{name:'Row 1'})).toBeInTheDocument()
  expect(screen.getAllByText('"0xff"')).toHaveLength(2)
  expect(screen.getAllByText('HEX')).toHaveLength(1)
  expect(screen.getByText('"9007199254740993"')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Distribution'}))
  fireEvent.change(screen.getByLabelText('Distribution column'),{target:{value:'1'}})
  const chart = screen.getByRole('img',{name:'Value frequency chart'})
  expect(within(chart).getByText('"0xff"')).toBeInTheDocument()
  expect(screen.getByText(/1 binary, complex/)).toBeInTheDocument()
})
