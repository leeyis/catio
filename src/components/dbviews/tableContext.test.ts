import { describe, it, expect } from 'vitest'
import { buildTableContext } from './tableContext'
import type { TableStructure } from '../../services/types'

const relStruct: TableStructure = {
  comment: '',
  columns: [
    { name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: '' },
    { name: 'name', type: 'varchar(255)', nullable: true, default: null, key: '', extra: '' },
    { name: 'status', type: 'text', nullable: false, default: "'new'", key: '', extra: '' },
  ],
  indexes: [{ name: 'idx_name', cols: 'name', unique: false, method: 'btree' }],
  fks: [{ col: 'owner_id', ref: 'users(id)', onDelete: 'CASCADE', onUpdate: '' }],
}

describe('buildTableContext — relational', () => {
  it('renders a CREATE TABLE with schema-qualified name, columns, NOT NULL and PRIMARY KEY', () => {
    const out = buildTableContext('postgres', 'public', 'orders', relStruct)
    expect(out).toContain('CREATE TABLE "public"."orders"')
    expect(out).toContain('"id" bigint NOT NULL')
    expect(out).toContain('"name" varchar(255)')
    expect(out).toContain('PRIMARY KEY ("id")')
  })

  it('uses MySQL backtick quoting for mysql engine', () => {
    const out = buildTableContext('mysql', 'shop', 'orders', relStruct)
    expect(out).toContain('CREATE TABLE `orders`')
    expect(out).toContain('`id` bigint NOT NULL')
  })

  it('appends indexes and foreign keys as comment lines', () => {
    const out = buildTableContext('postgres', 'public', 'orders', relStruct)
    expect(out).toContain('idx_name')
    expect(out).toContain('owner_id')
    expect(out).toContain('users(id)')
  })

  it('falls back to relational rendering for an unknown engine', () => {
    const out = buildTableContext('weirddb', 'public', 'orders', relStruct)
    expect(out).toContain('CREATE TABLE')
  })
})

describe('buildTableContext — mongodb', () => {
  const mongoStruct: TableStructure = {
    comment: '',
    columns: [
      { name: '_id', type: 'objectId', nullable: false, default: null, key: 'PK', extra: '' },
      { name: 'name', type: 'string', nullable: true, default: null, key: '', extra: '' },
    ],
    indexes: [{ name: 'name_1', cols: 'name', unique: true, method: '' }],
    fks: [],
  }

  it('renders a collection field list with _id marked as primary key', () => {
    const out = buildTableContext('mongodb', 'mydb', 'users', mongoStruct)
    expect(out).toMatch(/collection "users"/i)
    expect(out).toContain('_id: objectId')
    expect(out).toMatch(/primary key/i)
    expect(out).toContain('name: string')
    expect(out).not.toContain('CREATE TABLE')
  })

  it('notes when a collection has no inferable fields', () => {
    const empty: TableStructure = { comment: '', columns: [], indexes: [], fks: [] }
    const out = buildTableContext('mongodb', 'mydb', 'empty', empty)
    expect(out).toMatch(/collection "empty"/i)
    expect(out).toMatch(/no .*field/i)
  })
})

describe('buildTableContext — elasticsearch', () => {
  const esStruct: TableStructure = {
    comment: '',
    columns: [
      { name: '_id', type: 'keyword', nullable: false, default: null, key: 'PK', extra: '' },
      { name: 'title', type: 'text', nullable: true, default: null, key: '', extra: '' },
    ],
    indexes: [],
    fks: [],
  }

  it('renders an index mapping field list', () => {
    const out = buildTableContext('elasticsearch', '', 'articles', esStruct)
    expect(out).toMatch(/index "articles" mapping/i)
    expect(out).toContain('title: text')
    expect(out).not.toContain('CREATE TABLE')
  })
})
