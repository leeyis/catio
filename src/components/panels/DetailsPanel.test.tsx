import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataProvider } from '../../state/DataContext'
import { DetailsPanel } from './DetailsPanel'
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

describe('DetailsPanel', () => {
  it('renders the passed connection name and sub', () => {
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} />)
    expect(screen.getAllByText('my-server').length).toBeGreaterThan(0)
    expect(screen.getByText('deploy@1.2.3.4:22')).toBeTruthy()
  })

  it('Connect button calls onConnect with the conn', () => {
    const onConnect = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onConnect={onConnect} />)
    fireEvent.click(screen.getByText('连接'))
    expect(onConnect).toHaveBeenCalledWith(CONN)
  })

  it('pencil (edit) calls onEdit with the conn', () => {
    const onEdit = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onEdit={onEdit} />)
    fireEvent.click(screen.getByTitle('编辑'))
    expect(onEdit).toHaveBeenCalledWith(CONN)
  })

  it('Copy button calls onCopy with the conn', () => {
    const onCopy = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onCopy={onCopy} />)
    fireEvent.click(screen.getByText('复制'))
    expect(onCopy).toHaveBeenCalledWith(CONN)
  })

  it('trash (delete) calls onDelete with the conn', () => {
    const onDelete = vi.fn()
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} onDelete={onDelete} />)
    fireEvent.click(screen.getByTitle('删除'))
    expect(onDelete).toHaveBeenCalledWith(CONN)
  })

  it('shows Close-session (not Connect) when connected, calling onCloseSession', () => {
    const onCloseSession = vi.fn()
    wrap(<DetailsPanel conn={CONN} connected onClose={() => {}} onCloseSession={onCloseSession} />)
    expect(screen.queryByText('连接')).toBeNull()
    fireEvent.click(screen.getByText('关闭会话'))
    expect(onCloseSession).toHaveBeenCalledWith(CONN)
  })

  it('hides the last-used row when lastUsed is undefined', () => {
    wrap(<DetailsPanel conn={CONN} onClose={() => {}} />)
    expect(screen.queryByText('最近使用')).toBeNull()
  })
})
