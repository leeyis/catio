import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { ConnRow } from './Sidebar'
import type { Connection } from '../../services/types'

function wrap(ui: React.ReactNode) {
  return render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
}

const dbConn: Connection = {
  id: 'db-1', group: 'prod', kind: 'db', name: 'my-pg',
  sub: 'postgres · 127.0.0.1:5432', icon: 'database', engine: 'postgres', status: 'idle',
}
const hostConn: Connection = {
  id: 'h-1', group: 'prod', kind: 'host', name: 'web-01',
  sub: '10.0.0.1', icon: 'server', status: 'up', proto: 'ssh',
}

describe('ConnRow', () => {
  it('db card click opens the details panel (onDetail), not the workbench', () => {
    const onOpen = vi.fn()
    const onDetail = vi.fn()
    wrap(<ConnRow conn={dbConn} onOpen={onOpen} onDetail={onDetail} />)
    fireEvent.click(screen.getByText('my-pg'))
    expect(onDetail).toHaveBeenCalledWith(dbConn)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('db row does not render the detail icon button on hover', () => {
    const { container } = wrap(<ConnRow conn={dbConn} onOpen={() => {}} onDetail={() => {}} />)
    const row = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(row)
    // No detail-icon button (title="详情") for db rows.
    expect(screen.queryByTitle('详情')).toBeNull()
  })

  it('host card click opens the workbench (onOpen) — unchanged', () => {
    const onOpen = vi.fn()
    const onDetail = vi.fn()
    wrap(<ConnRow conn={hostConn} onOpen={onOpen} onDetail={onDetail} />)
    fireEvent.click(screen.getByText('web-01'))
    expect(onOpen).toHaveBeenCalledWith(hostConn)
    expect(onDetail).not.toHaveBeenCalled()
  })

  it('host row does not render a detail icon on hover (merged UI: click opens details)', () => {
    // After merging the redesigned shell, the per-card hover detail icon was
    // removed — clicking the card itself opens the details panel.
    const { container } = wrap(<ConnRow conn={hostConn} onOpen={() => {}} onDetail={() => {}} />)
    const row = container.firstElementChild as HTMLElement
    fireEvent.mouseEnter(row)
    expect(screen.queryByTitle('详情')).toBeNull()
  })
})
