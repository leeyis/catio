import { describe, expect, it } from 'vitest'
import { functionCompletions, sqlFunctionSignatureHelp } from './sqlAdvancedCompletion'

const item = (name: string, engine: string) => functionCompletions(name, engine).find(entry => entry.label === name)
describe('dialect-correct function suggestions', () => {
  it.each([
    ['postgres','DATE_FORMAT'], ['postgres','IFNULL'], ['postgres','JSON_EXTRACT'],
    ['mysql','STRING_AGG'], ['mysql','ARRAY_AGG'], ['mysql','IIF'],
    ['sqlite','NOW'], ['sqlite','JSON_KEYS'], ['sqlite','MD5'],
    ['sqlserver','LENGTH'], ['sqlserver','NOW'], ['sqlserver','JSON_EXTRACT'],
    ['oracle','IFNULL'], ['oracle','GEN_RANDOM_UUID'], ['jdbc','GEN_RANDOM_UUID'],
    ['h2','GEN_RANDOM_UUID'], ['duckdb','JSONB_BUILD_OBJECT'],
  ])('does not suggest %s-incompatible function %s', (engine, name) => {
    expect(item(name, engine)).toBeUndefined()
    const sql = `SELECT ${name}(`
    expect(sqlFunctionSignatureHelp(sql, sql.length, engine)).toBeNull()
  })
  it.each([
    ['postgres','DATE_TRUNC'], ['mysql','DATE_FORMAT'], ['tidb','DATE_FORMAT'],
    ['sqlite','STRFTIME'], ['sqlserver','LEN'], ['sqlserver','GETDATE'],
    ['oracle','NVL'], ['oceanbase-oracle','NVL'], ['h2','RANDOM_UUID'], ['duckdb','LIST_VALUE'],
  ])('offers supported %s function %s', (engine, name) => expect(item(name, engine)).toBeDefined())
  it.each(['postgres','mysql','sqlite','sqlserver','oracle','jdbc','h2','duckdb'])('uses AS syntax inside CAST for %s', engine => {
    expect(item('CAST', engine)?.apply).toBe('CAST(expression AS type)')
  })
  it('uses FROM syntax rather than a comma for EXTRACT', () => {
    expect(item('EXTRACT', 'postgres')?.apply).toBe('EXTRACT(field FROM source)')
  })
  it('uses the actual SQL Server DATEDIFF argument list', () => {
    expect(item('DATEDIFF', 'sqlserver')?.apply).toBe('DATEDIFF(datepart, startdate, enddate)')
  })
})
