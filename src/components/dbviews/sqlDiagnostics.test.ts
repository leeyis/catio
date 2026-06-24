import { describe, it, expect } from 'vitest'
import { sqlDiagnostics, linterTableNames } from './sqlDiagnostics'

const ns = (name: string, tables: string[], views: string[] = []) => ({
  name,
  tables: tables.map(t => ({ name: t })),
  views: views.map(v => ({ name: v })),
})

const SCHEMA = { tables: ['orders', 'customers', 'order_items'] }

describe('sqlDiagnostics — 括号/引号', () => {
  it('合法 SQL 无诊断', () => {
    expect(sqlDiagnostics('SELECT * FROM orders WHERE id = 1', SCHEMA)).toEqual([])
  })

  it('未闭合的左括号报错,并定位到该括号', () => {
    const d = sqlDiagnostics('SELECT count( FROM orders', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('error')
    expect(d[0].message).toMatch(/未闭合的括号/)
    // count( 的 '(' 在第 1 行第 13 列(1-based)
    expect(d[0].startLine).toBe(1)
    expect(d[0].startColumn).toBe(13)
  })

  it('多出的右括号报错,并定位到该括号', () => {
    const d = sqlDiagnostics('SELECT id) FROM orders', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('error')
    expect(d[0].message).toMatch(/多余的右括号|未匹配的括号/)
    expect(d[0].startColumn).toBe(10)
  })

  it('括号内的右括号被字符串包裹时不误判', () => {
    expect(sqlDiagnostics("SELECT ')' FROM orders", SCHEMA)).toEqual([])
  })

  it('未闭合的单引号字符串报错', () => {
    const d = sqlDiagnostics("SELECT * FROM orders WHERE name = 'abc", SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('error')
    expect(d[0].message).toMatch(/未闭合的字符串|未闭合的引号/)
  })

  it('跨行定位:第二行的未闭合括号定位到第 2 行', () => {
    const d = sqlDiagnostics('SELECT *\nFROM (orders', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].startLine).toBe(2)
    // 'FROM (' 的 '(' 在第 2 行第 6 列
    expect(d[0].startColumn).toBe(6)
  })
})

describe('sqlDiagnostics — 未知表名', () => {
  it('FROM 已知表不报警', () => {
    expect(sqlDiagnostics('SELECT * FROM orders', SCHEMA)).toEqual([])
  })

  it('FROM 未知表给出 warning,并定位表名', () => {
    const d = sqlDiagnostics('SELECT * FROM ordeers', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('warning')
    expect(d[0].message).toMatch(/未知的表|未知表/)
    expect(d[0].message).toMatch(/ordeers/)
    // 表名 ordeers 从第 15 列开始
    expect(d[0].startColumn).toBe(15)
  })

  it('JOIN 未知表给出 warning', () => {
    const d = sqlDiagnostics('SELECT * FROM orders JOIN nope ON 1=1', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('warning')
    expect(d[0].message).toMatch(/nope/)
  })

  it('表名大小写不敏感', () => {
    expect(sqlDiagnostics('SELECT * FROM ORDERS', SCHEMA)).toEqual([])
  })

  it('带别名的已知表不报警', () => {
    expect(sqlDiagnostics('SELECT o.id FROM orders o', SCHEMA)).toEqual([])
  })

  it('schema 限定名(public.orders)取末段比对,已知则不报警', () => {
    expect(sqlDiagnostics('SELECT * FROM public.orders', SCHEMA)).toEqual([])
  })

  it('空 schema(未加载)时不做未知表诊断,避免误报', () => {
    expect(sqlDiagnostics('SELECT * FROM whatever', { tables: [] })).toEqual([])
  })

  it('忽略注释中的内容,不误判括号/表名', () => {
    expect(sqlDiagnostics('-- SELECT * FROM nope (\nSELECT * FROM orders', SCHEMA)).toEqual([])
  })

  it('WITH 定义的 CTE 别名不被当作未知表误报', () => {
    expect(
      sqlDiagnostics('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent', SCHEMA),
    ).toEqual([])
  })

  it('WITH 链中的多个 CTE 别名都不被误报', () => {
    const sql =
      'WITH a AS (SELECT * FROM orders), b AS (SELECT * FROM customers) ' +
      'SELECT * FROM a JOIN b ON 1=1'
    expect(sqlDiagnostics(sql, SCHEMA)).toEqual([])
  })

  it('CTE 别名豁免不影响真实未知表的检测', () => {
    const d = sqlDiagnostics('WITH recent AS (SELECT * FROM orders) SELECT * FROM nope', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].message).toMatch(/nope/)
  })
})

describe('linterTableNames — 未知表诊断的表名来源', () => {
  const demo = { schemas: [ns('public', ['orders', 'customers', 'line_items'])] }
  const live = { schemas: [ns('public', ['users', 'sessions'])] }

  it('未连接(mock 模式)用 demo schema 的表名', () => {
    expect(linterTableNames(undefined, null, demo).sort()).toEqual(
      ['customers', 'line_items', 'orders'].sort(),
    )
  })

  it('已连接且 liveSchema 加载完成时用 liveSchema 的表名', () => {
    expect(linterTableNames('conn-1', live, demo).sort()).toEqual(['sessions', 'users'].sort())
  })

  it('已连接但 liveSchema 仍为 null(加载中/失败)时返回空,避免对真实表用 demo 名误报', () => {
    expect(linterTableNames('conn-1', null, demo)).toEqual([])
  })

  it('同时收集 tables 与 views', () => {
    const live2 = { schemas: [ns('public', ['t1'], ['v1'])] }
    expect(linterTableNames('conn-1', live2, demo).sort()).toEqual(['t1', 'v1'].sort())
  })
})

describe('sqlDiagnostics — 块注释闭合', () => {
  it('未闭合的块注释报错', () => {
    const d = sqlDiagnostics('SELECT /* note', SCHEMA)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('error')
    expect(d[0].message).toMatch(/未闭合的块注释/)
  })

  it('已闭合的块注释不报错', () => {
    expect(sqlDiagnostics('SELECT /* note */ * FROM orders', SCHEMA)).toEqual([])
  })
})
