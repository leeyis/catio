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
  let lastKeyDown: { key: string; code: string; keyCode: number; at: number; pairedWithPriorInput: boolean } | null = null
  const pendingInputs: Array<{ data: string; at: number }> = []
  const deferredCleanupTimers = new Set<ReturnType<typeof setTimeout>>()
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
      && !lastKeyDown.pairedWithPriorInput
      && now - lastKeyDown.at <= INPUT_KEYDOWN_WINDOW_MS
      && (lastKeyDown.key === inputEvent.data || lastKeyDown.keyCode === 229)
    if (followsKeyDown) return
    if (!dataSentDuringInput) term.input(inputEvent.data, true)
    pendingInputs.push({ data: inputEvent.data, at: now })
  }
  const onCompositionStart = () => {
    lastKeyDown = null
    pendingInputs.length = 0
  }
  const dataListener = term.onData(() => {
    dataSentDuringInput = true
    if (lastKeyDown?.keyCode === 229 && !lastKeyDown.pairedWithPriorInput) {
      lastKeyDown = null
    }
  })

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
      const canPairPending = event.keyCode === 229
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey
      const pendingIndex = canPairPending && pendingInputs.length > 0 ? 0 : -1
      const keyDownState = {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        at: now,
        pairedWithPriorInput: pendingIndex !== -1,
      }
      lastKeyDown = keyDownState
      if (pendingIndex === -1 && event.keyCode === 229) {
        const outerTimer = setTimeout(() => {
          deferredCleanupTimers.delete(outerTimer)
          const innerTimer = setTimeout(() => {
            deferredCleanupTimers.delete(innerTimer)
            if (lastKeyDown === keyDownState) lastKeyDown = null
          }, 0)
          deferredCleanupTimers.add(innerTimer)
        }, 0)
        deferredCleanupTimers.add(outerTimer)
      }
      if (pendingIndex === -1) return false

      pendingInputs.splice(pendingIndex, 1)
      return true
    },
    dispose() {
      ownerDocument.removeEventListener('input', onInputCapture, true)
      textarea.removeEventListener('input', onInput)
      textarea.removeEventListener('compositionstart', onCompositionStart)
      dataListener.dispose()
      for (const timer of deferredCleanupTimers) clearTimeout(timer)
      deferredCleanupTimers.clear()
    },
  }
}
