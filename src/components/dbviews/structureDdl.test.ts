import { describe, it, expect } from 'vitest'
import {
  buildAddColumn, buildModifyColumn, buildCreateTableDDL, qualifiedTable, dialectFor,
  type ColumnDraft,
} from './structureDdl'
import type { TableStructure } from '../../services/types'

const draft = (over: Partial<ColumnDraft> = {}): ColumnDraft =>
  ({ name: 'note', type: 'varchar(50)', nullable: true, default: '', comment: '', ...over })

describe('structureDdl — ADD COLUMN with comment', () => {
  it('MySQL carries the comment inline in the column definition', () => {
    const q = qualifiedTable('mysql', 'eastmoney', 'orders')
    const stmts = buildAddColumn('mysql', q, draft({ name: 'remark', type: 'varchar(50)', comment: '备注' }))
    expect(stmts).toEqual(["ALTER TABLE `eastmoney`.`orders` ADD COLUMN `remark` varchar(50) COMMENT '备注';"])
  })

  it("MySQL escapes single quotes in the comment", () => {
    const q = qualifiedTable('mysql', undefined, 't')
    const stmts = buildAddColumn('mysql', q, draft({ name: 'c', type: 'int', comment: "it's" }))
    expect(stmts[0]).toContain("COMMENT 'it''s'")
  })

  it('Postgres emits a separate COMMENT ON COLUMN statement', () => {
    const q = qualifiedTable('postgres', 'public', 'orders')
    const stmts = buildAddColumn('postgres', q, draft({ name: 'remark', type: 'text', comment: 'note' }))
    expect(stmts).toEqual([
      'ALTER TABLE "public"."orders" ADD COLUMN "remark" text;',
      `COMMENT ON COLUMN "public"."orders"."remark" IS 'note';`,
    ])
  })

  it('no comment → no COMMENT clause/statement', () => {
    expect(buildAddColumn('mysql', '`t`', draft({ name: 'c', type: 'int' })))
      .toEqual(['ALTER TABLE `t` ADD COLUMN `c` int;'])
    expect(buildAddColumn('postgres', '"t"', draft({ name: 'c', type: 'int' })))
      .toEqual(['ALTER TABLE "t" ADD COLUMN "c" int;'])
  })
})

describe('structureDdl — MODIFY COLUMN with comment', () => {
  const orig = (over: Partial<ColumnDraft> = {}): ColumnDraft =>
    ({ name: 'c', type: 'int', nullable: true, default: '', comment: '老注释', ...over })

  it('MySQL re-emits the existing comment on a type change so it is not dropped', () => {
    const stmts = buildModifyColumn('mysql', '`t`', orig(), { ...orig(), type: 'bigint' })
    expect(stmts).toEqual(["ALTER TABLE `t` MODIFY COLUMN `c` bigint COMMENT '老注释';"])
  })

  it('MySQL comment-only change still emits a MODIFY carrying the new comment', () => {
    const stmts = buildModifyColumn('mysql', '`t`', orig(), { ...orig(), comment: '新注释' })
    expect(stmts).toEqual(["ALTER TABLE `t` MODIFY COLUMN `c` int COMMENT '新注释';"])
  })

  it('Postgres comment change emits a standalone COMMENT ON COLUMN', () => {
    const stmts = buildModifyColumn('postgres', '"t"', orig(), { ...orig(), comment: '新注释' })
    expect(stmts).toEqual([`COMMENT ON COLUMN "t"."c" IS '新注释';`])
  })

  it('Postgres clearing the comment emits IS NULL', () => {
    const stmts = buildModifyColumn('postgres', '"t"', orig(), { ...orig(), comment: '' })
    expect(stmts).toEqual([`COMMENT ON COLUMN "t"."c" IS NULL;`])
  })

  it('Postgres comment statement targets the NEW name after a rename', () => {
    const stmts = buildModifyColumn('postgres', '"t"', orig(), { ...orig(), name: 'c2', comment: 'x' })
    expect(stmts).toEqual([
      'ALTER TABLE "t" RENAME COLUMN "c" TO "c2";',
      `COMMENT ON COLUMN "t"."c2" IS 'x';`,
    ])
  })

  it('unchanged comment produces no comment statement', () => {
    expect(buildModifyColumn('postgres', '"t"', orig(), { ...orig(), type: 'bigint' }))
      .toEqual(['ALTER TABLE "t" ALTER COLUMN "c" TYPE bigint;'])
  })
})

describe('structureDdl — CREATE TABLE DDL includes comments', () => {
  const st: TableStructure = {
    comment: '订单表',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: '', comment: '主键' },
      { name: 'amount', type: 'int', nullable: true, default: null, key: '', extra: '', comment: '' },
    ],
    indexes: [],
    fks: [],
  }

  it('MySQL inlines column comments and a trailing table comment', () => {
    const ddl = buildCreateTableDDL('mysql', 'eastmoney.orders', st)
    expect(ddl).toContain("comment '主键'")
    expect(ddl).toContain("comment='订单表'")
    // only the one commented column gets an inline `comment '…'` (amount has none)
    expect((ddl.match(/comment '/g) ?? []).length).toBe(1)
  })

  it('Postgres appends COMMENT ON statements after the CREATE', () => {
    const ddl = buildCreateTableDDL('postgres', 'public.orders', st)
    expect(ddl).toContain("comment on table public.orders is '订单表';")
    expect(ddl).toContain("comment on column public.orders.id is '主键';")
    // no inline comments for postgres
    expect(ddl).not.toContain("comment '主键'")
  })

  it('a structure with no comments yields no comment clauses', () => {
    const bare: TableStructure = { comment: '', columns: [{ name: 'id', type: 'int', nullable: false, default: null, key: 'PK', extra: '', comment: '' }], indexes: [], fks: [] }
    expect(buildCreateTableDDL('mysql', 't', bare)).not.toContain('comment')
    expect(buildCreateTableDDL('postgres', 't', bare)).not.toContain('comment on')
  })
})

describe('structureDdl — dialectFor sanity', () => {
  it('maps engines to quoting dialects', () => {
    expect(dialectFor('mysql')).toBe('mysql')
    expect(dialectFor('mariadb')).toBe('mysql')
    expect(dialectFor('postgres')).toBe('postgres')
    expect(dialectFor(undefined)).toBe('postgres')
  })
})

describe('structureDdl — qualifiedTable qualifies with schema for BOTH dialects', () => {
  it('MySQL qualifies with the database so cross-database ALTERs resolve correctly', () => {
    // Regression: an unqualified `ods_org_issueinfo` resolved against the connection's
    // current db (esales) instead of eastmoney → "table doesn't exist".
    expect(qualifiedTable('mysql', 'eastmoney', 'ods_org_issueinfo')).toBe('`eastmoney`.`ods_org_issueinfo`')
  })
  it('Postgres qualifies with the schema', () => {
    expect(qualifiedTable('postgres', 'public', 'orders')).toBe('"public"."orders"')
  })
  it('falls back to the bare table when no schema is given', () => {
    expect(qualifiedTable('mysql', undefined, 't')).toBe('`t`')
    expect(qualifiedTable('postgres', '', 't')).toBe('"t"')
  })
})
