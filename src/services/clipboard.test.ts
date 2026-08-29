import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

describe('copyTextToClipboard', () => {
  const execCommand = vi.fn()

  beforeEach(() => {
    execCommand.mockReset()
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('reports success only after the Clipboard API write resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyTextToClipboard('127.0.0.1:9999')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('127.0.0.1:9999')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('reports failure when the Clipboard API and fallback both fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    execCommand.mockReturnValue(false)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyTextToClipboard('127.0.0.1:9999')).resolves.toBe(false)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
