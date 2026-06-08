import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { HistoryPanel } from './HistoryPanel'
import type { HistoryItem } from '../../services/types'

const ITEMS: HistoryItem[] = [
  { id: 'h1', kind: 'shell', target: 'prod-web', text: 'ls -la', when: '10:00', dur: '12ms', exitCode: 0 },
  { id: 'h2', kind: 'shell', target: 'prod-web', text: 'false', when: '10:01', dur: '5ms', exitCode: 1 },
]

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('HistoryPanel', () => {
  it('renders both history rows', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('false')).toBeTruthy()
  })

  it('applies danger color to failed (exitCode != 0) row text', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    const failedText = screen.getByText('false')
    expect(failedText.style.color).toBe('var(--danger-fg)')
  })

  it('shows exit badge for failed command', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    expect(screen.getByText('exit 1')).toBeTruthy()
  })

  it('does not show exit badge for successful command (exitCode 0)', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    expect(screen.queryByText('exit 0')).toBeNull()
  })

  it('does not apply danger color to successful row text', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    const successText = screen.getByText('ls -la')
    expect(successText.style.color).not.toBe('var(--danger-fg)')
  })

  it('calls onInsert when insert button is clicked', () => {
    const onInsert = vi.fn()
    wrap(
      <HistoryPanel
        onClose={() => {}}
        items={ITEMS}
        onInsert={onInsert}
        canInsert
      />
    )
    // Hover over the first row to reveal its buttons
    const firstRow = screen.getByText('ls -la').closest('.col') as HTMLElement
    fireEvent.mouseEnter(firstRow)
    // Click the insert button (arrow-right-to-line icon button)
    const insertBtns = screen.getAllByTitle('插入终端')
    fireEvent.click(insertBtns[0])
    expect(onInsert).toHaveBeenCalledWith('ls -la')
  })

  it('does not render insert button when onInsert is not provided', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    expect(screen.queryByTitle('插入终端')).toBeNull()
  })

  it('does not render insert button when canInsert is false', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} onInsert={vi.fn()} canInsert={false} />)
    expect(screen.queryByTitle('插入终端')).toBeNull()
  })

  it('opens ConfirmModal when clear history button is clicked', () => {
    wrap(
      <HistoryPanel
        onClose={() => {}}
        items={ITEMS}
        onClear={() => {}}
      />
    )
    fireEvent.click(screen.getByText('清空历史'))
    expect(screen.getByText('清空命令历史')).toBeTruthy()
    expect(screen.getByText('确定清空全部命令历史吗？此操作不可撤销。')).toBeTruthy()
  })

  it('calls onClear when ConfirmModal is confirmed', () => {
    const onClear = vi.fn()
    wrap(
      <HistoryPanel
        onClose={() => {}}
        items={ITEMS}
        onClear={onClear}
      />
    )
    fireEvent.click(screen.getByText('清空历史'))
    // ConfirmModal shows two '清空历史' elements: the footer button and the confirm button
    const allClearBtns = screen.getAllByText('清空历史')
    // The last one is the confirm button inside the modal
    fireEvent.click(allClearBtns[allClearBtns.length - 1])
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('does not show clear history button when onClear is not provided', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} />)
    expect(screen.queryByText('清空历史')).toBeNull()
  })

  it('does not show clear history button when items list is empty', () => {
    wrap(<HistoryPanel onClose={() => {}} items={[]} onClear={() => {}} />)
    expect(screen.queryByText('清空历史')).toBeNull()
  })

  it('renders empty state when no items match', () => {
    wrap(<HistoryPanel onClose={() => {}} items={[]} />)
    expect(screen.getByText('无匹配的历史记录')).toBeTruthy()
  })
})
