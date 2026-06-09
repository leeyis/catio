import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '../../i18n'
import { AlertModal } from './AlertModal'

describe('AlertModal', () => {
  it('renders the title and message', () => {
    render(<AlertModal title="连接失败" message="认证失败" onClose={() => {}} />)
    expect(screen.getByText('连接失败')).toBeTruthy()
    expect(screen.getByText('认证失败')).toBeTruthy()
  })

  it('calls onClose from the OK button', () => {
    const onClose = vi.fn()
    render(<AlertModal title="t" message="m" confirmLabel="确定" onClose={onClose} />)
    fireEvent.click(screen.getByText('确定'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
