import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { SnippetsPanel } from './SnippetsPanel'
import type { Snippet } from '../../services/types'

// Mock the store so we can assert mutations without touching localStorage.
vi.mock('../../state/snippets', () => ({
  saveSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  newSnippetId: () => 's-test-1',
}))
import { saveSnippet, deleteSnippet } from '../../state/snippets'

const SNIPS: Snippet[] = [
  { id: 's1', scope: 'Shell', desc: 'list files', icon: 'terminal', code: 'ls -la' },
]

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('SnippetsPanel', () => {
  it('renders a snippet row', () => {
    wrap(<SnippetsPanel onClose={() => {}} snippets={SNIPS} />)
    expect(screen.getByText('list files')).toBeTruthy()
    expect(screen.getByText('ls -la')).toBeTruthy()
  })

  it('calls onInsert with the snippet code', () => {
    const onInsert = vi.fn()
    wrap(<SnippetsPanel onClose={() => {}} snippets={SNIPS} onInsert={onInsert} canInsert />)
    const row = screen.getByText('list files').closest('.col') as HTMLElement
    fireEvent.mouseEnter(row)
    fireEvent.click(screen.getByTitle('插入终端'))
    expect(onInsert).toHaveBeenCalledWith('ls -la')
  })

  it('does not render insert button when canInsert is false', () => {
    wrap(<SnippetsPanel onClose={() => {}} snippets={SNIPS} onInsert={vi.fn()} canInsert={false} />)
    expect(screen.queryByTitle('插入终端')).toBeNull()
  })

  it('opens the editor via + and saves a new snippet', () => {
    const onChange = vi.fn()
    wrap(<SnippetsPanel onClose={() => {}} snippets={SNIPS} onChange={onChange} />)
    fireEvent.click(screen.getByTitle('新建片段'))
    // Editor open: fill the code textarea, then confirm.
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'whoami' } })
    fireEvent.click(screen.getByText('确定'))
    expect(saveSnippet).toHaveBeenCalledTimes(1)
    expect((saveSnippet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: 's-test-1', scope: 'Shell', code: 'whoami' })
    expect(onChange).toHaveBeenCalled()
  })

  it('deletes a snippet via the confirm modal', () => {
    const onChange = vi.fn()
    wrap(<SnippetsPanel onClose={() => {}} snippets={SNIPS} onChange={onChange} />)
    const row = screen.getByText('list files').closest('.col') as HTMLElement
    fireEvent.mouseEnter(row)
    // The row delete button title === '删除片段'; clicking opens ConfirmModal.
    fireEvent.click(screen.getByTitle('删除片段'))
    expect(screen.getByText('确定删除该片段吗？')).toBeTruthy()
    // Confirm button shares the '删除片段' label — pick the last occurrence (modal button).
    const delHits = screen.getAllByText('删除片段')
    fireEvent.click(delHits[delHits.length - 1])
    expect(deleteSnippet).toHaveBeenCalledWith('s1')
    expect(onChange).toHaveBeenCalled()
  })
})
