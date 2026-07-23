import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installXtermImeInputFix } from './xtermImeInputFix'

function input(data: string, isComposing = false): InputEvent {
  const event = new InputEvent('input', {
    data,
    inputType: 'insertText',
    composed: true,
    bubbles: true,
  })
  Object.defineProperty(event, 'isComposing', { value: isComposing })
  return event
}

function key(type: 'keydown' | 'keyup', value: string, keyCode: number): KeyboardEvent {
  const event = new KeyboardEvent(type, { key: value, code: `Key${value.toUpperCase()}` })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  return event
}

function createHarness() {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const emitted: string[] = []
  const dataListeners = new Set<(data: string) => void>()
  let keyDownSeen = false
  let keyPressHandled = false
  const emit = (data: string) => {
    emitted.push(data)
    for (const listener of dataListeners) listener(data)
  }

  textarea.addEventListener('input', event => {
    const inputEvent = event as InputEvent
    if (inputEvent.data && !inputEvent.isComposing && !keyPressHandled
      && (!inputEvent.composed || !keyDownSeen)) {
      emit(inputEvent.data)
    }
  }, true)

  const terminal = {
    textarea,
    input: vi.fn((data: string) => emit(data)),
    onData: vi.fn((listener: (data: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    }),
  } as unknown as Terminal

  return {
    emitted,
    emit,
    terminal,
    textarea,
    setXtermState(downSeen: boolean, pressHandled: boolean) {
      keyDownSeen = downSeen
      keyPressHandled = pressHandled
    },
    dispose() { textarea.remove() },
  }
}

describe('installXtermImeInputFix', () => {
  it('preserves Doubao input after space and punctuation keydowns', () => {
    const h = createHarness()
    const fix = installXtermImeInputFix(h.terminal)

    h.textarea.dispatchEvent(input('l'))
    expect(fix.handleKeyEvent(key('keydown', 'l', 229))).toBe(true)
    h.setXtermState(true, false)
    h.textarea.dispatchEvent(input('s'))
    expect(fix.handleKeyEvent(key('keydown', 's', 229))).toBe(true)

    expect(fix.handleKeyEvent(key('keydown', ' ', 32))).toBe(false)
    h.emit(' ')
    h.setXtermState(true, true)
    h.textarea.dispatchEvent(input(' '))
    expect(fix.handleKeyEvent(key('keydown', '-', 189))).toBe(false)
    h.emit('-')

    for (const character of ['a', 'l', 'h']) {
      h.textarea.dispatchEvent(input(character))
      expect(fix.handleKeyEvent(key('keydown', character, 229))).toBe(true)
    }

    expect(h.emitted.join('')).toBe('ls -alh')
    h.dispose()
  })

  it('does not duplicate normal keydown-first input', () => {
    const h = createHarness()
    const fix = installXtermImeInputFix(h.terminal)

    expect(fix.handleKeyEvent(key('keydown', 'a', 65))).toBe(false)
    h.emit('a')
    h.setXtermState(true, true)
    h.textarea.dispatchEvent(input('a'))
    expect(fix.handleKeyEvent(key('keyup', 'a', 65))).toBe(false)

    expect(h.emitted).toEqual(['a'])
    expect(h.terminal.input).not.toHaveBeenCalled()
    h.dispose()
  })

  it('leaves real composition input to xterm', () => {
    const h = createHarness()
    const fix = installXtermImeInputFix(h.terminal)

    h.textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    h.textarea.dispatchEvent(input('中', true))
    expect(fix.handleKeyEvent(key('keydown', 'Process', 229))).toBe(false)

    expect(h.emitted).toEqual([])
    expect(h.terminal.input).not.toHaveBeenCalled()
    h.dispose()
  })
})
