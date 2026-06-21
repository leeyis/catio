import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { ObjectPane } from './ObjectPane'

// Backend object-source fetch is mocked so we control the rendered src string.
const objectSource = vi.fn()
vi.mock('../../services/db', () => ({
  objectSource: (...a: unknown[]) => objectSource(...a),
  dbErrMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

// CodeMirror does not run under jsdom; stub the editor to a plain element.
vi.mock('../dbviews/SqlEditor', () => ({
  SqlEditor: ({ code }: { code: string }) => <div data-testid="sql-editor">{code}</div>,
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
    expect(editor).toHaveTextContent('select 1 as one;')
    const copyBtn = screen.getByTitle('Copy DDL')
    fireEvent.click(copyBtn)
    expect(writeText).toHaveBeenCalledWith('select 1 as one;')
    // Copy feedback: tooltip switches to the translated 'Copied' (not a raw i18n key).
    expect(await screen.findByTitle('Copied')).toBeInTheDocument()
    expect(screen.queryByTitle('common.copied')).toBeNull()
  })
})
