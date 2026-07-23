import type { IDisposable, Terminal } from '@xterm/xterm'

export interface XtermImeInputFix extends IDisposable {
  /** Return true when xterm should not process this keyboard event. */
  handleKeyEvent(event: KeyboardEvent): boolean
}

const INPUT_KEYDOWN_WINDOW_MS = 250

/** Work around https://github.com/xtermjs/xterm.js/issues/5887. */
export function installXtermImeInputFix(term: Terminal): XtermImeInputFix {
  const textarea = term.textarea
  if (!textarea) return { handleKeyEvent: () => false, dispose() {} }

  let dataSentDuringInput = false
  let lastKeyDown: { key: string; code: string; at: number } | null = null
  const pendingInputs: Array<{ data: string; sent: boolean; at: number }> = []
  const ownerDocument = textarea.ownerDocument

  const expirePending = (now: number) => {
    while (pendingInputs[0] && now - pendingInputs[0].at > INPUT_KEYDOWN_WINDOW_MS) {
      pendingInputs.shift()
    }
  }
  const onInputCapture = (event: Event) => {
    if (event.target === textarea) dataSentDuringInput = false
  }
  const onInput = (event: Event) => {
    const inputEvent = event as InputEvent
    if (!inputEvent.data || inputEvent.inputType !== 'insertText' || inputEvent.isComposing) return

    const now = Date.now()
    expirePending(now)
    const followsKeyDown = lastKeyDown !== null
      && now - lastKeyDown.at <= INPUT_KEYDOWN_WINDOW_MS
      && lastKeyDown.key === inputEvent.data
    if (!followsKeyDown) {
      pendingInputs.push({ data: inputEvent.data, sent: dataSentDuringInput, at: now })
    }
  }
  const onCompositionStart = () => {
    lastKeyDown = null
    pendingInputs.length = 0
  }
  const dataListener = term.onData(() => { dataSentDuringInput = true })

  ownerDocument.addEventListener('input', onInputCapture, true)
  textarea.addEventListener('input', onInput)
  textarea.addEventListener('compositionstart', onCompositionStart)

  return {
    handleKeyEvent(event) {
      if (event.type === 'keyup') {
        if (lastKeyDown && event.key === lastKeyDown.key && event.code === lastKeyDown.code) {
          lastKeyDown = null
        }
        return false
      }
      if (event.type !== 'keydown' || event.isComposing) return false

      const now = Date.now()
      expirePending(now)
      const pendingIndex = pendingInputs.findIndex(input => input.data === event.key)
      lastKeyDown = { key: event.key, code: event.code, at: now }
      if (pendingIndex === -1) return false

      const [pending] = pendingInputs.splice(pendingIndex, 1)
      if (!pending.sent) term.input(pending.data, true)
      return true
    },
    dispose() {
      ownerDocument.removeEventListener('input', onInputCapture, true)
      textarea.removeEventListener('input', onInput)
      textarea.removeEventListener('compositionstart', onCompositionStart)
      dataListener.dispose()
    },
  }
}
