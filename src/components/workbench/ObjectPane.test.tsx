import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { ObjectPane } from './ObjectPane'

// Backend object-source fetch/save are mocked so we control the rendered src
// string and observe the save call.
const objectSource = vi.fn()
const saveObjectSource = vi.fn()
vi.mock('../../services/db', () => ({
  objectSource: (...a: unknown[]) => objectSource(...a),
  saveObjectSource: (...a: unknown[]) => saveObjectSource(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

// CodeMirror does not run under jsdom; stub the editor to a controlled textarea
// so tests can both read `code` and drive `onChange` (edits).
vi.mock('../dbviews/SqlEditor', () => ({
  SqlEditor: ({ code, onChange }: { code: string; onChange: (v: string) => void }) => (
    <textarea data-testid="sql-editor" value={code} onChange={e => onChange(e.target.value)} />
  ),
}))

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('ObjectPane 源码复制', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('copies the object source to the clipboard', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    objectSource.mockResolvedValue('select 1 as one;')
    wrap(<ObjectPane connId="c1" schema="public" name="v_orders" objKind="view" />)
    const editor = await screen.findByTestId('sql-editor')
    expect(editor).toHaveValue('select 1 as one;')
    const copyBtn = screen.getByTitle('Copy DDL')
    fireEvent.click(copyBtn)
    expect(writeText).toHaveBeenCalledWith('select 1 as one;')
    // Copy feedback: tooltip switches to the translated 'Copied' (not a raw i18n key).
    expect(await screen.findByTitle('Copied')).toBeInTheDocument()
    expect(screen.queryByTitle('common.copied')).toBeNull()
  })
})

describe('ObjectPane 源码编辑保存', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })
  beforeEach(() => { objectSource.mockReset(); saveObjectSource.mockReset() })

  it('saves the edited source via the backend save command', async () => {
    objectSource.mockResolvedValue('CREATE OR REPLACE VIEW v AS SELECT 1;')
    saveObjectSource.mockResolvedValue(0)
    wrap(<ObjectPane connId="c1" schema="public" name="v_orders" objKind="view" />)

    const editor = await screen.findByTestId('sql-editor')
    // 用户编辑源码。
    fireEvent.change(editor, { target: { value: 'CREATE OR REPLACE VIEW v AS SELECT 2;' } })

    const saveBtn = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(saveBtn)

    await waitFor(() => expect(saveObjectSource).toHaveBeenCalledWith(
      'c1', 'public', 'v_orders', 'view', 'CREATE OR REPLACE VIEW v AS SELECT 2;'))
    // 保存成功后给出反馈。
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('disables Save until the source is edited and again after a successful save', async () => {
    objectSource.mockResolvedValue('CREATE OR REPLACE VIEW v AS SELECT 1;')
    saveObjectSource.mockResolvedValue(0)
    wrap(<ObjectPane connId="c1" schema="public" name="v_orders" objKind="view" />)

    const editor = await screen.findByTestId('sql-editor')
    const saveBtn = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    // 未编辑(pristine):保存按钮禁用,避免误触发 DDL 重跑。
    expect(saveBtn).toBeDisabled()

    // 用户编辑后变 dirty:按钮可用。
    fireEvent.change(editor, { target: { value: 'CREATE OR REPLACE VIEW v AS SELECT 2;' } })
    expect(saveBtn).toBeEnabled()

    fireEvent.click(saveBtn)
    await waitFor(() => expect(saveObjectSource).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Saved')).toBeInTheDocument()

    // 保存成功后回到 pristine:按钮再次禁用,重复点击不会重跑 DDL。
    await waitFor(() => expect(saveBtn).toBeDisabled())
  })

  it('surfaces a save error from the backend', async () => {
    objectSource.mockResolvedValue('CREATE OR REPLACE VIEW v AS SELECT 1;')
    saveObjectSource.mockRejectedValue(new Error('boom'))
    wrap(<ObjectPane connId="c1" schema="public" name="v_orders" objKind="view" />)

    const editor = await screen.findByTestId('sql-editor')
    fireEvent.change(editor, { target: { value: 'CREATE OR REPLACE VIEW v AS SELECT 2;' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Save failed: boom/)).toBeInTheDocument()
  })
})
