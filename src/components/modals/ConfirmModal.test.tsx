import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { ConfirmModal } from './ConfirmModal'

function wrap(ui: React.ReactNode) {
  return render(<LanguageProvider>{ui}</LanguageProvider>)
}

describe('ConfirmModal', () => {
  it('renders the title and message', () => {
    wrap(
      <ConfirmModal title="删除连接" message="确定要删除吗？" confirmLabel="删除"
        onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByText('删除连接')).toBeTruthy()
    expect(screen.getByText('确定要删除吗？')).toBeTruthy()
  })

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn()
    wrap(
      <ConfirmModal title="t" message="m" confirmLabel="删除" danger
        onConfirm={onConfirm} onCancel={() => {}} />
    )
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn()
    wrap(
      <ConfirmModal title="t" message="m" confirmLabel="删除"
        onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
