import { describe, it, expect } from 'vitest'
import { buildInsertSql, buildUpdateSql, sqlValue } from './copySql'

// 复制为 SQL 的纯函数单测。语义参照后端 src-tauri/src/db/dml.rs 的 value_to_sql/build_insert/build_update,
// 方言引号沿用 structureDdl 的 dialectFor/quoteIdent(postgres 用 "x",mysql 用 `x`)。

describe('sqlValue', () => {
  it('null / undefined → NULL', () => {
    expect(sqlValue(null)).toBe('NULL')
    expect(sqlValue(undefined)).toBe('NULL')
  })
  it('数字按字面量原样输出,不加引号', () => {
    expect(sqlValue(42)).toBe('42')
    expect(sqlValue(3.14)).toBe('3.14')
    expect(sqlValue(0)).toBe('0')
  })
  it('布尔 → TRUE/FALSE', () => {
    expect(sqlValue(true)).toBe('TRUE')
    expect(sqlValue(false)).toBe('FALSE')
  })
  it('字符串加单引号,内嵌单引号加倍转义', () => {
    expect(sqlValue('hello')).toBe("'hello'")
    expect(sqlValue("O'Brien")).toBe("'O''Brien'")
  })
  it('对象/数组 → JSON 编码后作为字符串字面量', () => {
    expect(sqlValue({ a: 1 })).toBe(`'{"a":1}'`)
    expect(sqlValue([1, 2])).toBe("'[1,2]'")
  })
})

const cols = ['id', 'name', 'price']

describe('buildInsertSql', () => {
  it('单行 postgres:双引号标识符 + 值转义', () => {
    const sql = buildInsertSql([[1, "O'Brien", 9.5]], 'orders', cols, 'postgres')
    expect(sql).toBe(`INSERT INTO "orders" ("id", "name", "price") VALUES (1, 'O''Brien', 9.5);`)
  })
  it('mysql 用反引号', () => {
    const sql = buildInsertSql([[1, 'a', 2]], 'orders', cols, 'mysql')
    expect(sql).toBe('INSERT INTO `orders` (`id`, `name`, `price`) VALUES (1, \'a\', 2);')
  })
  it('NULL 值', () => {
    const sql = buildInsertSql([[1, null, 2]], 'orders', cols, 'postgres')
    expect(sql).toBe(`INSERT INTO "orders" ("id", "name", "price") VALUES (1, NULL, 2);`)
  })
  it('多行 → 多条语句,以换行分隔', () => {
    const sql = buildInsertSql([[1, 'a', 2], [3, 'b', 4]], 'orders', cols, 'postgres')
    expect(sql).toBe(
      `INSERT INTO "orders" ("id", "name", "price") VALUES (1, 'a', 2);\n` +
      `INSERT INTO "orders" ("id", "name", "price") VALUES (3, 'b', 4);`,
    )
  })
  it('schema 限定表名', () => {
    const sql = buildInsertSql([[1, 'a', 2]], 'orders', cols, 'postgres', 'public')
    expect(sql).toBe(`INSERT INTO "public"."orders" ("id", "name", "price") VALUES (1, 'a', 2);`)
  })
})

describe('buildUpdateSql', () => {
  it('无主键 → SET 全列(无 WHERE)', () => {
    const sql = buildUpdateSql([[1, 'a', 2]], 'orders', cols, 'postgres', undefined, [])
    expect(sql).toBe(`UPDATE "orders" SET "id" = 1, "name" = 'a', "price" = 2;`)
  })
  it('有主键 id → SET 非主键列,WHERE 用主键定位', () => {
    const sql = buildUpdateSql([[7, 'shipped', 2]], 'orders', cols, 'postgres', undefined, ['id'])
    expect(sql).toBe(`UPDATE "orders" SET "name" = 'shipped', "price" = 2 WHERE "id" = 7;`)
  })
  it('转义 + mysql 反引号 + 多行', () => {
    const sql = buildUpdateSql([[1, "O'Brien", 2], [3, 'b', 4]], 'orders', cols, 'mysql', undefined, ['id'])
    expect(sql).toBe(
      'UPDATE `orders` SET `name` = \'O\'\'Brien\', `price` = 2 WHERE `id` = 1;\n' +
      'UPDATE `orders` SET `name` = \'b\', `price` = 4 WHERE `id` = 3;',
    )
  })
  it('schema 限定 + 复合主键', () => {
    const sql = buildUpdateSql([[1, 'a', 2]], 'orders', cols, 'postgres', 'public', ['id', 'name'])
    expect(sql).toBe(`UPDATE "public"."orders" SET "price" = 2 WHERE "id" = 1 AND "name" = 'a';`)
  })
})
