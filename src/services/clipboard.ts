export function fallbackCopyText(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  ta.style.top = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)

  const sel = document.getSelection()
  const ranges: Range[] = []
  if (sel) {
    for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i))
  }

  ta.select()
  ta.setSelectionRange(0, ta.value.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()

  if (sel) {
    sel.removeAllRanges()
    for (const r of ranges) sel.addRange(r)
  }
  return ok
}

export function copyTextToClipboard(text: string): boolean {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const secure = typeof window !== 'undefined' && window.isSecureContext
  if (secure && clip && typeof clip.writeText === 'function') {
    clip.writeText(text).catch(() => { fallbackCopyText(text) })
    return true
  }
  return fallbackCopyText(text)
}
