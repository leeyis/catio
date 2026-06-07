import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { ConnectSecretPrompt } from './ConnectSecretPrompt'

function wrap(ui: React.ReactNode) {
  return render(<LanguageProvider>{ui}</LanguageProvider>)
}

describe('ConnectSecretPrompt', () => {
  it('renders label', () => {
    wrap(<ConnectSecretPrompt label="输入密码" onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getAllByText('输入密码').length).toBeGreaterThan(0)
  })

  it('calls onSubmit with the typed value', () => {
    const onSubmit = vi.fn()
    const { container } = wrap(<ConnectSecretPrompt label="输入密码" onSubmit={onSubmit} onCancel={() => {}} />)
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByText('确认'))
    expect(onSubmit).toHaveBeenCalledWith('hunter2')
  })

  it('does not render the secret as a plaintext attribute', () => {
    const { container } = wrap(<ConnectSecretPrompt label="输入密码" onSubmit={() => {}} onCancel={() => {}} />)
    const input = container.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'supersecret' } })
    // The input must be type="password", not type="text"
    expect(input.type).toBe('password')
    // The secret must not appear as a visible text node in the DOM
    expect(container.textContent ?? '').not.toContain('supersecret')
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    wrap(<ConnectSecretPrompt label="输入密码" onSubmit={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })
})
