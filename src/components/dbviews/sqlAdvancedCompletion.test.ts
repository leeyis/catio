import { describe, it, expect } from 'vitest'
import {
  sqlFunctionSignatureHelp,
  functionCompletions,
  joinSuggestions,
  type JoinTable,
} from './sqlAdvancedCompletion'

// ---- 函数签名提示 (getSqlFunctionSignatureHelp) ----
describe('sqlFunctionSignatureHelp', () => {
  it('返回光标所在函数的签名与参数列表', () => {
    const sql = 'SELECT SUBSTRING('
    const help = sqlFunctionSignatureHelp(sql, sql.length)
    expect(help).not.toBeNull()
    expect(help!.name).toBe('SUBSTRING')
    expect(help!.parameters).toEqual(['string', 'start', 'length'])
    expect(help!.signature).toBe('SUBSTRING(string, start, length)')
    expect(help!.activeParameter).toBe(0)
  })

  it('按顶层逗号数推进 activeParameter', () => {
    const sql = "SELECT SUBSTRING(name, 1"
    const help = sqlFunctionSignatureHelp(sql, sql.length)
    expect(help!.activeParameter).toBe(1)
  })

  it('忽略括号/字符串内的逗号(嵌套调用不误增 activeParameter)', () => {
    const sql = "SELECT CONCAT(UPPER(a, b), 'x,y'"
    const help = sqlFunctionSignatureHelp(sql, sql.length)
    expect(help!.name).toBe('CONCAT')
    expect(help!.activeParameter).toBe(1)
  })

  it('activeParameter 不超过最后一个参数(可变参数函数)', () => {
    const sql = 'SELECT COALESCE(a, b, c, d'
    const help = sqlFunctionSignatureHelp(sql, sql.length)
    expect(help!.name).toBe('COALESCE')
    // COALESCE 参数为 [value, ...values],activeParameter 封顶在 1
    expect(help!.activeParameter).toBe(1)
  })

  it('未处于任何函数调用内时返回 null', () => {
    const sql = 'SELECT id FROM users'
    expect(sqlFunctionSignatureHelp(sql, sql.length)).toBeNull()
  })

  it('未知函数返回 null', () => {
    const sql = 'SELECT NOTAREALFUNC('
    expect(sqlFunctionSignatureHelp(sql, sql.length)).toBeNull()
  })

  it('括号已闭合(不在调用内)返回 null', () => {
    const sql = 'SELECT ABS(1) '
    expect(sqlFunctionSignatureHelp(sql, sql.length)).toBeNull()
  })

  it('按引擎方言加入专属函数(postgres GEN_RANDOM_UUID)', () => {
    const sql = 'SELECT GEN_RANDOM_UUID('
    expect(sqlFunctionSignatureHelp(sql, sql.length, 'mysql')).toBeNull()
    const help = sqlFunctionSignatureHelp(sql, sql.length, 'postgres')
    expect(help).not.toBeNull()
    expect(help!.parameters).toEqual([])
  })
})

// ---- 函数名补全 (function completions) ----
describe('functionCompletions', () => {
  it('按前缀给出函数补全候选,apply 携带占位参数模板', () => {
    const items = functionCompletions('SUBST')
    const sub = items.find(i => i.label === 'SUBSTRING')
    expect(sub).toBeTruthy()
    expect(sub!.apply).toBe('SUBSTRING(string, start, length)')
    expect(sub!.detail).toBe('SUBSTRING(string, start, length)')
  })

  it('无参函数 apply 只带空括号', () => {
    const items = functionCompletions('NOW')
    const now = items.find(i => i.label === 'NOW')
    expect(now!.apply).toBe('NOW()')
  })

  it('前缀大小写不敏感', () => {
    const items = functionCompletions('coun')
    expect(items.map(i => i.label)).toContain('COUNT')
  })

  it('空前缀返回全部通用函数', () => {
    const items = functionCompletions('')
    expect(items.length).toBeGreaterThan(20)
  })

  it('引擎专属函数仅在对应方言出现', () => {
    expect(functionCompletions('GEN_RAND', 'mysql').map(i => i.label)).not.toContain('GEN_RANDOM_UUID')
    expect(functionCompletions('GEN_RAND', 'postgres').map(i => i.label)).toContain('GEN_RANDOM_UUID')
  })

  it('不匹配的前缀返回空', () => {
    expect(functionCompletions('ZZZQ')).toEqual([])
  })
})

// ---- 外键 JOIN 建议 (foreign-key JOIN suggestions) ----
const tables: JoinTable[] = [
  {
    name: 'orders',
    columns: ['id', 'user_id', 'total'],
    foreignKeys: [{ column: 'user_id', refTable: 'users', refColumn: 'id' }],
  },
  {
    name: 'users',
    columns: ['id', 'name'],
    foreignKeys: [],
  },
  {
    name: 'order_items',
    columns: ['id', 'order_id', 'qty'],
    foreignKeys: [{ column: 'order_id', refTable: 'orders', refColumn: 'id' }],
  },
]

describe('joinSuggestions', () => {
  it('在 FROM 后给出与其有外键关系的表的 JOIN 候选', () => {
    const before = 'SELECT * FROM orders '
    const items = joinSuggestions(before, tables)
    const labels = items.map(i => i.label)
    expect(labels).toContain('JOIN users ON orders.user_id = users.id')
    // order_items 通过 order_id -> orders.id 也相关
    expect(labels).toContain('JOIN order_items ON order_items.order_id = orders.id')
  })

  it('apply 文本携带引擎方言的标识符引用(postgres 双引号)', () => {
    const before = 'SELECT * FROM orders '
    const items = joinSuggestions(before, tables, 'postgres')
    const join = items.find(i => i.label.includes('users'))
    expect(join!.apply).toBe('JOIN "users" ON "orders"."user_id" = "users"."id"')
  })

  it('apply 文本在 mysql 方言下用反引号', () => {
    const before = 'SELECT * FROM orders '
    const items = joinSuggestions(before, tables, 'mysql')
    const join = items.find(i => i.label.includes('users'))
    expect(join!.apply).toBe('JOIN `users` ON `orders`.`user_id` = `users`.`id`')
  })

  it('已在 FROM 子句出现的表不重复给出已有的(基于最后一个引用表给候选)', () => {
    // orders 与 users 都已引用,光标在新的 JOIN 处:基于已引用表给与其相关的下一张表
    const before = 'SELECT * FROM orders JOIN users ON orders.user_id = users.id JOIN '
    const items = joinSuggestions(before, tables)
    const labels = items.map(i => i.label)
    // order_items 与 orders 相关,应被建议
    expect(labels).toContain('JOIN order_items ON order_items.order_id = orders.id')
    // 不应再建议把 users 自己 JOIN 回来(已引用)
    expect(labels.some(l => l.startsWith('JOIN users '))).toBe(false)
  })

  it('非 FROM/JOIN 上下文(如 WHERE)不给 JOIN 建议', () => {
    const before = 'SELECT * FROM orders WHERE '
    expect(joinSuggestions(before, tables)).toEqual([])
  })

  it('没有外键关系的孤立表不产生候选', () => {
    const lonely: JoinTable[] = [
      { name: 'logs', columns: ['id', 'msg'], foreignKeys: [] },
      { name: 'metrics', columns: ['id', 'val'], foreignKeys: [] },
    ]
    const before = 'SELECT * FROM logs '
    expect(joinSuggestions(before, lonely)).toEqual([])
  })

  it('JOIN 关键字后(刚输入 JOIN,未指定表)也给候选', () => {
    const before = 'SELECT * FROM orders JOIN '
    const items = joinSuggestions(before, tables)
    expect(items.map(i => i.label)).toContain('JOIN users ON orders.user_id = users.id')
  })
})
