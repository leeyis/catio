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

  it('hides 插入终端 for shell rows when no active terminal (canInsert false)', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} onInsert={vi.fn()} canInsert={false} />)
    expect(screen.queryByTitle('插入终端')).toBeNull()
  })

  it('shows 插入编辑器 for SQL rows when a DB tab is focused and dispatches catio-insert', () => {
    const sqlItems: HistoryItem[] = [{ id: 's1', kind: 'sql', target: 'pg', text: 'select 1', when: '10:00', dur: '2ms' }]
    const handler = vi.fn()
    window.addEventListener('catio-insert', handler)
    wrap(<HistoryPanel onClose={() => {}} items={sqlItems} canInsertEditor />)
    fireEvent.click(screen.getByTitle('插入编辑器'))
    expect(handler).toHaveBeenCalled()
    window.removeEventListener('catio-insert', handler)
  })

  it('hides 插入编辑器 for SQL rows when no DB tab is focused', () => {
    const sqlItems: HistoryItem[] = [{ id: 's1', kind: 'sql', target: 'pg', text: 'select 1', when: '10:00', dur: '2ms' }]
    wrap(<HistoryPanel onClose={() => {}} items={sqlItems} />)
    expect(screen.queryByTitle('插入编辑器')).toBeNull()
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

  it('shows the "connect first" hint and no rows when no connection is active', () => {
    wrap(<HistoryPanel onClose={() => {}} items={ITEMS} noActiveConnection />)
    expect(screen.getByText('请先连接主机或数据库')).toBeTruthy()
    expect(screen.queryByText('ls -la')).toBeNull()
  })

  it('scopes to shell history when a host tab is active', () => {
    const mixed: HistoryItem[] = [
      { id: 'sh', kind: 'shell', target: 'prod-web', text: 'whoami', when: '10:00', dur: '1ms' },
      { id: 'sq', kind: 'sql', target: 'pg', text: 'select 1', when: '10:01', dur: '2ms' },
    ]
    wrap(<HistoryPanel onClose={() => {}} items={mixed} activeKind="shell" />)
    expect(screen.getByText('whoami')).toBeTruthy()
    expect(screen.queryByText('select 1')).toBeNull()
  })

  it('scopes DB history to the active tab database type (engine)', () => {
    const mixed: HistoryItem[] = [
      { id: 'm', kind: 'sql', target: 'ttfund', text: 'db.apps.find({})', when: '10:00', dur: '1ms', engine: 'mongodb' },
      { id: 'p', kind: 'sql', target: 'pg', text: 'select 1', when: '10:01', dur: '2ms', engine: 'postgres' },
      { id: 'legacy', kind: 'sql', target: 'conn-9', text: 'select legacy', when: '10:02', dur: '3ms' },
    ]
    wrap(<HistoryPanel onClose={() => {}} items={mixed} activeKind="sql" activeEngine="mongodb" />)
    expect(screen.getByText('db.apps.find({})')).toBeTruthy()
    // other database type is filtered out…
    expect(screen.queryByText('select 1')).toBeNull()
    // …but legacy rows without a recorded engine are kept (can't be classified)
    expect(screen.getByText('select legacy')).toBeTruthy()
  })
})
