import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import i18n from '../../i18n'
import { StructureView } from './StructureView'
import type { TableStructure } from '../../services/types'

// Backend structure fetch is mocked so the live path renders a known structure
// (including column comments) without Tauri.
const tableStructure = vi.fn()
const dropTableChildObject = vi.fn()
vi.mock('../../services/db', () => ({
  tableStructure: (...a: unknown[]) => tableStructure(...a),
  runQuery: vi.fn(),
  dropTableChildObject: (...a: unknown[]) => dropTableChildObject(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const wrap = (ui: React.ReactNode) =>
  render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)

const longComment = '这是一个非常非常非常长的列注释用于验证省略号截断与 title 悬浮显示全文的行为'

const struct: TableStructure = {
  comment: '订单主表 · 表级注释也用 title 显示全文',
  columns: [
    { name: 'id', type: 'bigint', nullable: false, default: null, key: 'PK', extra: 'identity', comment: '主键编号' },
    { name: 'note', type: 'text', nullable: true, default: null, key: '', extra: '', comment: longComment },
    { name: 'status', type: 'text', nullable: false, default: null, key: '', extra: 'enum', comment: '' },
  ],
  indexes: [],
  fks: [],
}

describe('StructureView 备注列', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('renders col.comment in the comment column (not col.extra)', async () => {
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="orders" connId="c1" schema="public" />)
    // comment values are rendered…
    expect(await screen.findByText('主键编号')).toBeInTheDocument()
    // …and the `extra` field is no longer the comment column's source.
    expect(screen.queryByText('enum')).toBeNull()
  })

  it('truncates a long comment with a title carrying the full text', async () => {
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="orders" connId="c1" schema="public" />)
    const cell = await screen.findByTitle(longComment)
    expect(cell).toBeInTheDocument()
  })

  it('shows the table-level comment with a title for hover full text', async () => {
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="orders" connId="c1" schema="public" />)
    await waitFor(() => expect(tableStructure).toHaveBeenCalled())
    const tableComment = await screen.findByText(struct.comment)
    expect(tableComment).toHaveAttribute('title', struct.comment)
  })
})

describe('StructureView 非关系型裁剪', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('relational engine shows DDL + 外键 tabs and 添加列', async () => {
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="orders" connId="c1" schema="public" engine="postgres" />)
    await screen.findByText('主键编号')
    expect(screen.getByText('DDL')).toBeInTheDocument()
    expect(screen.getByText('Add column')).toBeInTheDocument()
  })

  it('MongoDB hides DDL + 外键 tabs and 添加列 (no DDL concept), keeps 列/索引', async () => {
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="users" connId="c1" schema="app" engine="mongodb" />)
    await screen.findByText('主键编号')
    expect(screen.queryByText('DDL')).toBeNull()
    expect(screen.queryByText('Add column')).toBeNull()
    // 列/索引 segments stay (Columns label carries a count suffix).
    expect(screen.getByText(/^Columns/)).toBeInTheDocument()
    expect(screen.getByText(/^Indexes/)).toBeInTheDocument()
  })
})

describe('StructureView 索引删除安全门控', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  const withIndex: TableStructure = {
    ...struct,
    indexes: [{ name: 'idx_orders_status', cols: 'status', unique: false, method: 'btree' }],
  }

  it('索引删除需输入索引名原文才放行,确认按钮为 danger 且初始禁用', async () => {
    tableStructure.mockResolvedValue(withIndex)
    dropTableChildObject.mockResolvedValue(0)
    wrap(<StructureView table="orders" connId="c1" schema="public" engine="postgres" />)
    await screen.findByText('主键编号')
    fireEvent.click(screen.getByText(/^Indexes/))
    // 打开删除确认弹窗
    fireEvent.click(await screen.findByTitle('Drop index'))
    const confirm = await screen.findByTestId('child-drop-confirm')
    // 未输入名字时禁用,且不会触发删除
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(dropTableChildObject).not.toHaveBeenCalled()
    // 输入错误名字仍禁用
    const input = screen.getByTestId('child-drop-input')
    fireEvent.change(input, { target: { value: 'wrong' } })
    expect(confirm).toBeDisabled()
    // 输入正确名字后放行,删除被调用
    fireEvent.change(input, { target: { value: 'idx_orders_status' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(dropTableChildObject).toHaveBeenCalledWith('c1', 'INDEX', 'public', 'orders', 'idx_orders_status'))
  })
})

describe('StructureView 外键删除安全门控', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  const withFk: TableStructure = {
    ...struct,
    fks: [{ name: 'fk_orders_user', col: 'user_id', ref: 'public.users.id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
  }

  it('外键删除按约束名走 dropTableChildObject(FOREIGN_KEY),需输入约束名原文', async () => {
    tableStructure.mockResolvedValue(withFk)
    dropTableChildObject.mockResolvedValue(0)
    wrap(<StructureView table="orders" connId="c1" schema="public" engine="postgres" />)
    await screen.findByText('主键编号')
    fireEvent.click(screen.getByText(/^Foreign keys/))
    fireEvent.click(await screen.findByTitle('Drop foreign key'))
    const confirm = await screen.findByTestId('child-drop-confirm')
    expect(confirm).toBeDisabled()
    const input = screen.getByTestId('child-drop-input')
    fireEvent.change(input, { target: { value: 'fk_orders_user' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(dropTableChildObject).toHaveBeenCalledWith('c1', 'FOREIGN_KEY', 'public', 'orders', 'fk_orders_user'))
  })
})

describe('StructureView 触发器展示与删除', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  const withTrigger: TableStructure = {
    ...struct,
    triggers: [{ name: 'orders_audit', timing: 'AFTER', event: 'INSERT' }],
  }

  it('触发器 tab 列出触发器,删除按名门控并调用 dropTableChildObject(TRIGGER)', async () => {
    tableStructure.mockResolvedValue(withTrigger)
    dropTableChildObject.mockResolvedValue(0)
    wrap(<StructureView table="orders" connId="c1" schema="public" engine="postgres" />)
    await screen.findByText('主键编号')
    fireEvent.click(screen.getByText(/^Triggers/))
    expect(await screen.findByText('orders_audit')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Drop trigger'))
    const confirm = await screen.findByTestId('child-drop-confirm')
    expect(confirm).toBeDisabled()
    const input = screen.getByTestId('child-drop-input')
    fireEvent.change(input, { target: { value: 'orders_audit' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(dropTableChildObject).toHaveBeenCalledWith('c1', 'TRIGGER', 'public', 'orders', 'orders_audit'))
  })
})

describe('StructureView DDL 复制', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('shows a copy button only on the DDL tab and copies the full DDL', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    tableStructure.mockResolvedValue(struct)
    wrap(<StructureView table="orders" connId="c1" schema="public" />)
    // No copy button on the default (columns) tab.
    await screen.findByText('主键编号')
    expect(screen.queryByTitle('Copy DDL')).toBeNull()
    // Switch to the DDL tab.
    fireEvent.click(screen.getByText('DDL'))
    const copyBtn = await screen.findByTitle('Copy DDL')
    fireEvent.click(copyBtn)
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0] as string
    // The copied text is the create table DDL for the qualified table.
    expect(copied).toContain('create table')
    expect(copied).toContain('public.orders')
    // Copy feedback: tooltip switches to the translated 'Copied' (not a raw i18n key).
    expect(await screen.findByTitle('Copied')).toBeInTheDocument()
    expect(screen.queryByTitle('common.copied')).toBeNull()
  })
})
