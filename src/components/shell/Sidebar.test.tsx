import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { ConnRow } from './Sidebar'
import type { Connection } from '../../services/types'

const CONN: Connection = {
  id: 'live-1.2.3.4:22-deploy',
  group: '',
  kind: 'host',
  name: 'my-server',
  sub: 'deploy@1.2.3.4:22',
  icon: 'server',
  status: 'idle',
  proto: 'ssh',
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('Sidebar ConnRow', () => {
  it('clicking the card body calls onOpen (details path)', () => {
    const onOpen = vi.fn()
    wrap(<ConnRow conn={CONN} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('my-server'))
    expect(onOpen).toHaveBeenCalledWith(CONN)
  })

  it('no longer renders the per-card detail icon button', () => {
    const onOpen = vi.fn()
    const { container } = wrap(<ConnRow conn={CONN} onOpen={onOpen} />)
    // The old detail affordance was an icon-btn with title 详情.
    expect(screen.queryByTitle('详情')).toBeNull()
    // Hovering should not surface any inner button (the row is the only clickable).
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(container.querySelector('button')).toBeNull()
  })
})
