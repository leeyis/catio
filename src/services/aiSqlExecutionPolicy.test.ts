import { describe, it, expect } from 'vitest'
import {
  classifyAiSqlExecution,
  classifyConnectionEnvironment,
  stripAiSqlComments,
} from './aiSqlExecutionPolicy'
import type { Connection } from './types'

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'c', group: '', kind: 'db', name: 'db', sub: '', icon: 'database', status: 'up',
  engine: 'postgres', ...over,
})

describe('stripAiSqlComments', () => {
  it('strips block, line and hash comments', () => {
    const sql = "SELECT 1 /* x */ -- y\n# z\nFROM t"
    const out = stripAiSqlComments(sql)
    expect(out).not.toContain('/*')
    expect(out).not.toContain('--')
    expect(out).not.toContain('#')
    expect(out).toContain('SELECT 1')
    expect(out).toContain('FROM t')
  })
})

describe('classifyConnectionEnvironment', () => {
  it('marks names/hosts with prod signals as production', () => {
    expect(classifyConnectionEnvironment(conn({ name: 'prod-orders' }))).toBe('production')
    expect(classifyConnectionEnvironment(conn({ name: '正式库', sub: '' }))).toBe('production')
  })

  it('marks localhost / dev / staging signals as non_production', () => {
    expect(classifyConnectionEnvironment(conn({ name: 'localhost', sub: 'localhost' }))).toBe('non_production')
    expect(classifyConnectionEnvironment(conn({ name: 'dev-db', sub: '' }))).toBe('non_production')
    expect(classifyConnectionEnvironment(conn({ name: '测试库', sub: '' }))).toBe('non_production')
  })

  it('returns unknown when no signal and when no connection', () => {
    expect(classifyConnectionEnvironment(conn({ name: 'orders', sub: '10.0.0.5' }))).toBe('unknown')
    expect(classifyConnectionEnvironment(undefined)).toBe('unknown')
  })
})

describe('classifyAiSqlExecution — categories', () => {
  it('SELECT / WITH / SHOW / EXPLAIN → read, auto_execute', () => {
    for (const sql of ['SELECT * FROM t', 'WITH a AS (SELECT 1) SELECT * FROM a', 'SHOW TABLES', 'EXPLAIN SELECT 1']) {
      const d = classifyAiSqlExecution(sql, conn())
      expect(d.category).toBe('read')
      expect(d.action).toBe('auto_execute')
    }
  })

  it('DROP / TRUNCATE / ALTER → dangerous, block', () => {
    for (const sql of ['DROP TABLE t', 'TRUNCATE TABLE t', 'ALTER TABLE t ADD c int']) {
      const d = classifyAiSqlExecution(sql, conn())
      expect(d.category).toBe('dangerous')
      expect(d.action).toBe('block')
    }
  })

  it('CREATE → schema_change, confirm', () => {
    const d = classifyAiSqlExecution('CREATE TABLE t (id int)', conn())
    expect(d.category).toBe('schema_change')
    expect(d.action).toBe('confirm')
  })

  it('DELETE → write, confirm', () => {
    const d = classifyAiSqlExecution('DELETE FROM t WHERE id = 1', conn())
    expect(d.category).toBe('write')
    expect(d.action).toBe('confirm')
  })

  it('unscoped UPDATE → dangerous, block', () => {
    const d = classifyAiSqlExecution('UPDATE t SET x = 1', conn())
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
  })

  it('id-scoped UPDATE → low_risk_write; non-prod auto, prod confirm', () => {
    const sql = "UPDATE t SET x = 1 WHERE id = '5'"
    expect(classifyAiSqlExecution(sql, conn({ name: 'dev-db' })).action).toBe('auto_execute')
    expect(classifyAiSqlExecution(sql, conn({ name: 'prod-db' })).action).toBe('confirm')
    expect(classifyAiSqlExecution(sql, conn({ name: 'dev-db' })).category).toBe('low_risk_write')
  })

  it('INSERT → low_risk_write; non-prod auto, prod confirm', () => {
    const sql = 'INSERT INTO t (id) VALUES (1)'
    expect(classifyAiSqlExecution(sql, conn({ name: 'dev-db' })).action).toBe('auto_execute')
    expect(classifyAiSqlExecution(sql, conn({ name: 'prod-db' })).action).toBe('confirm')
  })

  it('empty SQL → block', () => {
    const d = classifyAiSqlExecution('   -- only a comment\n', conn())
    expect(d.action).toBe('block')
    expect(d.reasons).toContain('empty_sql')
  })

  it('data-modifying CTE (WITH ... DELETE/UPDATE/INSERT) must NOT be auto_execute', () => {
    // 形如 WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d
    // 不能因为以 WITH 开头就被当成只读直通执行
    const del = classifyAiSqlExecution('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', conn({ name: 'dev-db' }))
    expect(del.category).not.toBe('read')
    expect(del.action).not.toBe('auto_execute')

    const upd = classifyAiSqlExecution('WITH u AS (UPDATE orders SET paid = true RETURNING *) SELECT * FROM u', conn({ name: 'dev-db' }))
    expect(upd.category).not.toBe('read')
    expect(upd.action).not.toBe('auto_execute')

    const ins = classifyAiSqlExecution('WITH i AS (INSERT INTO orders (id) VALUES (1) RETURNING *) SELECT * FROM i', conn({ name: 'dev-db' }))
    expect(ins.category).not.toBe('read')
    expect(ins.action).not.toBe('auto_execute')
  })

  it('read-only CTE (WITH ... SELECT) stays read / auto_execute', () => {
    const d = classifyAiSqlExecution('WITH a AS (SELECT 1) SELECT * FROM a', conn())
    expect(d.category).toBe('read')
    expect(d.action).toBe('auto_execute')
  })

  it('UPDATE with WHERE only inside a string literal → dangerous (not low_risk_write)', () => {
    // 字符串里的 WHERE 不是真实条件,不能被当成 scoped update
    const d = classifyAiSqlExecution("UPDATE users SET note = 'where id = 1'", conn({ name: 'dev-db' }))
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
  })

  it('UPDATE with a real WHERE after a string literal stays low_risk_write', () => {
    const d = classifyAiSqlExecution("UPDATE users SET note = 'no condition' WHERE id = 7", conn({ name: 'dev-db' }))
    expect(d.category).toBe('low_risk_write')
    expect(d.action).toBe('auto_execute')
  })

  it('EXPLAIN ANALYZE wrapping a write must NOT be read / auto_execute', () => {
    // PG 等引擎 EXPLAIN ANALYZE 会真实执行被包裹的语句,不能当只读直通执行。
    const upd = classifyAiSqlExecution('EXPLAIN ANALYZE UPDATE orders SET paid = true', conn({ name: 'dev-db' }))
    expect(upd.category).not.toBe('read')
    expect(upd.action).not.toBe('auto_execute')

    const del = classifyAiSqlExecution('EXPLAIN ANALYZE DELETE FROM orders WHERE id = 1', conn({ name: 'dev-db' }))
    expect(del.category).not.toBe('read')
    expect(del.action).not.toBe('auto_execute')

    const drop = classifyAiSqlExecution('EXPLAIN ANALYZE DROP TABLE orders', conn({ name: 'dev-db' }))
    expect(drop.category).toBe('dangerous')
    expect(drop.action).toBe('block')
  })

  it('plain EXPLAIN (no ANALYZE) of a SELECT stays read / auto_execute', () => {
    const d = classifyAiSqlExecution('EXPLAIN SELECT * FROM orders', conn())
    expect(d.category).toBe('read')
    expect(d.action).toBe('auto_execute')
  })
})

describe('classifyAiSqlExecution — multi-statement', () => {
  it('any dangerous statement → block', () => {
    const d = classifyAiSqlExecution('SELECT 1; DROP TABLE t', conn({ name: 'dev-db' }))
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
    expect(d.reasons).toContain('multi_statement')
  })

  it('multiple writes (no dangerous) → confirm', () => {
    const d = classifyAiSqlExecution('INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (2)', conn({ name: 'dev-db' }))
    expect(d.action).toBe('confirm')
    expect(d.reasons).toContain('multi_statement')
  })

  it('multiple reads → auto_execute', () => {
    const d = classifyAiSqlExecution('SELECT 1; SELECT 2', conn())
    expect(d.category).toBe('read')
    expect(d.action).toBe('auto_execute')
  })

  it('a -- inside a string literal must NOT comment out a trailing dangerous statement', () => {
    // 字符串内的 -- 不应被当作行注释把后续 DROP 语句掩盖掉
    const d = classifyAiSqlExecution("SELECT '--'; DROP TABLE orders", conn({ name: 'dev-db' }))
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
  })

  it('a line comment containing an unpaired quote must NOT swallow a trailing dangerous statement', () => {
    // 攻击路径:行注释里含未配对引号时,若先 mask 字符串字面量再剥注释,
    // regex 会把 -- '...SELECT 'ok' 整体当成一个字符串字面量跨行吞掉,消掉分号,
    // 使 DROP TABLE 逃逸分类被 auto_execute,但 DB 实际会执行 DROP。
    const d = classifyAiSqlExecution("SELECT 1; -- '\nDROP TABLE t; SELECT 'ok'", conn({ name: 'dev-db' }))
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
  })

  it('a block comment containing an unpaired quote must NOT swallow a trailing dangerous statement', () => {
    // 同理:块注释里的未配对引号也不能让后续 DROP 逃逸。
    const d = classifyAiSqlExecution("SELECT 1 /* ' */; DROP TABLE t; SELECT 'ok'", conn({ name: 'dev-db' }))
    expect(d.category).toBe('dangerous')
    expect(d.action).toBe('block')
  })
})

describe('classifyAiSqlExecution — unknown statements', () => {
  it('unrecognized statement → confirm', () => {
    const d = classifyAiSqlExecution('VACUUM ANALYZE', conn())
    expect(d.category).toBe('unknown')
    expect(d.action).toBe('confirm')
  })
})
