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
vi.mock('../../services/db', () => ({
  tableStructure: (...a: unknown[]) => tableStructure(...a),
  runQuery: vi.fn(),
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
  })
})
