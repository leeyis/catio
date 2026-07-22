const SPLIT_REQUEST_EVENT = 'catio-agent-split-request'
const SPLIT_READY_EVENT = 'catio-agent-split-ready'
const SPLIT_CANCEL_EVENT = 'catio-agent-split-cancel'

interface SplitRequestDetail {
  tabId: string
  requestId: string
}

interface SplitReadyDetail extends SplitRequestDetail {
  chanId: string
}

let requestSeq = 0

export function onAgentTerminalSplitRequest(tabId: string, onRequest: (requestId: string) => void): () => void {
  const listener = (raw: Event) => {
    const detail = (raw as CustomEvent<SplitRequestDetail>).detail
    if (detail?.tabId === tabId && detail.requestId) onRequest(detail.requestId)
  }
  window.addEventListener(SPLIT_REQUEST_EVENT, listener)
  return () => window.removeEventListener(SPLIT_REQUEST_EVENT, listener)
}

export function onAgentTerminalSplitCancel(tabId: string, onCancel: (requestId: string) => void): () => void {
  const listener = (raw: Event) => {
    const detail = (raw as CustomEvent<SplitRequestDetail>).detail
    if (detail?.tabId === tabId && detail.requestId) onCancel(detail.requestId)
  }
  window.addEventListener(SPLIT_CANCEL_EVENT, listener)
  return () => window.removeEventListener(SPLIT_CANCEL_EVENT, listener)
}

export function notifyAgentTerminalSplitReady(tabId: string, requestId: string, chanId: string): void {
  window.dispatchEvent(new CustomEvent<SplitReadyDetail>(SPLIT_READY_EVENT, {
    detail: { tabId, requestId, chanId },
  }))
}

/** Ask the active terminal container to split and resolve when its new PTY is ready. */
export function requestAgentTerminalSplit(
  tabId: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null)
  const requestId = `agent-split-${Date.now()}-${requestSeq++}`
  return new Promise(resolve => {
    let settled = false
    let dispatched = false
    const finish = (chanId: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      window.removeEventListener(SPLIT_READY_EVENT, onReady)
      if (!chanId && dispatched) {
        window.dispatchEvent(new CustomEvent<SplitRequestDetail>(SPLIT_CANCEL_EVENT, {
          detail: { tabId, requestId },
        }))
      }
      resolve(chanId)
    }
    const onAbort = () => finish(null)
    const onReady = (raw: Event) => {
      const detail = (raw as CustomEvent<SplitReadyDetail>).detail
      if (detail?.tabId === tabId && detail.requestId === requestId) finish(detail.chanId)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    window.addEventListener(SPLIT_READY_EVENT, onReady)
    dispatched = true
    window.dispatchEvent(new CustomEvent<SplitRequestDetail>(SPLIT_REQUEST_EVENT, {
      detail: { tabId, requestId },
    }))
  })
}
