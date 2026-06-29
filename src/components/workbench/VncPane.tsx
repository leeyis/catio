/* VNC remote-desktop viewer. Connects via the vnc_* IPC, renders framebuffer
 * rectangles (Raw / CopyRect) onto a canvas, and forwards mouse + keyboard input.
 * Built on the unit-tested RFB codec; needs a live VNC server to verify end-to-end. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { vncConnect, vncPointer, vncKey, vncClose, listen } from '../../services/ssh'
import type { Connection } from '../../services/types'
import { Icon } from '../Icon'

export interface VncPaneProps {
  conn: Connection
  password: string
  active?: boolean
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

// Server (browser) deploy: VNC streams over the WebSocket, so the live path engages here too.
const isServer = (): boolean =>
  typeof window !== 'undefined' && '__CATIO_SERVER__' in window &&
  (window as unknown as Record<string, unknown>).__CATIO_SERVER__ === true

interface InitEvent { width: number; height: number; name?: string }
interface RectEvent { x: number; y: number; w: number; h: number; enc: 'raw' | 'copy'; data?: string; srcX?: number; srcY?: number }
interface ClosedEvent { error?: string | null }

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Browser key → X11 keysym for the common non-printable keys; printable chars use
// their codepoint (ASCII/Latin-1 align with X11 keysyms).
const SPECIAL_KEYSYMS: Record<string, number> = {
  Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7, CapsLock: 0xffe5,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
}
function keysymFor(e: KeyboardEvent): number | null {
  if (SPECIAL_KEYSYMS[e.key]) return SPECIAL_KEYSYMS[e.key]
  if (e.key.length === 1) return e.key.charCodeAt(0)
  return null
}

export function VncPane({ conn, password, active }: VncPaneProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<string | null>(null)
  const fbRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!isTauri() && !isServer()) { setStatus('error'); setErrMsg(t('vnc.noDesktop')); return }
    let disposed = false
    const unlisteners: Array<() => void> = []

    ;(async () => {
      let sid: string
      try {
        sid = await vncConnect(conn.host || '', conn.port || 5900, password)
      } catch (e) {
        if (!disposed) { setStatus('error'); setErrMsg(String((e as { message?: string } | null)?.message ?? e)) }
        return
      }
      if (disposed) { vncClose(sid); return }
      sessionRef.current = sid
      setStatus('live')

      const ctx = () => canvasRef.current?.getContext('2d') ?? null

      unlisteners.push(await listen<InitEvent>(`vnc-init://${sid}`, p => {
        fbRef.current = { w: p.width, h: p.height }
        const cv = canvasRef.current
        if (cv) { cv.width = p.width; cv.height = p.height }
      }))
      unlisteners.push(await listen<RectEvent>(`vnc-rect://${sid}`, p => {
        const c = ctx()
        if (!c) return
        try {
          if (p.enc === 'raw' && p.data) {
            const bytes = base64ToBytes(p.data)
            const img = new ImageData(p.w, p.h)
            for (let i = 0; i < p.w * p.h; i++) {
              img.data[i * 4] = bytes[i * 4]
              img.data[i * 4 + 1] = bytes[i * 4 + 1]
              img.data[i * 4 + 2] = bytes[i * 4 + 2]
              img.data[i * 4 + 3] = 255
            }
            c.putImageData(img, p.x, p.y)
          } else if (p.enc === 'copy' && p.srcX != null && p.srcY != null && canvasRef.current) {
            c.drawImage(canvasRef.current, p.srcX, p.srcY, p.w, p.h, p.x, p.y, p.w, p.h)
          }
        } catch { /* malformed frame */ }
      }))
      unlisteners.push(await listen<ClosedEvent>(`vnc-closed://${sid}`, p => {
        if (disposed) return
        setStatus('error')
        setErrMsg(p.error || t('vnc.closed'))
      }))
    })()

    return () => {
      disposed = true
      unlisteners.forEach(u => u())
      if (sessionRef.current) { vncClose(sessionRef.current); sessionRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id])

  // Map a mouse event to framebuffer coords + VNC button mask.
  function fbCoords(e: React.MouseEvent): { x: number; y: number } {
    const cv = canvasRef.current
    if (!cv) return { x: 0, y: 0 }
    const rect = cv.getBoundingClientRect()
    const sx = fbRef.current.w / (rect.width || 1)
    const sy = fbRef.current.h / (rect.height || 1)
    return {
      x: Math.max(0, Math.min(fbRef.current.w - 1, Math.round((e.clientX - rect.left) * sx))),
      y: Math.max(0, Math.min(fbRef.current.h - 1, Math.round((e.clientY - rect.top) * sy))),
    }
  }
  function buttonMask(e: React.MouseEvent): number {
    // browser buttons bitmask: 1=left, 2=right, 4=middle → VNC: 1=left, 2=middle, 4=right.
    const b = e.buttons
    return ((b & 1) ? 1 : 0) | ((b & 4) ? 2 : 0) | ((b & 2) ? 4 : 0)
  }
  function onMouse(e: React.MouseEvent) {
    const sid = sessionRef.current
    if (!sid) return
    const { x, y } = fbCoords(e)
    void vncPointer(sid, buttonMask(e), x, y)
  }

  // Keyboard: capture on the focusable container; forward as keysyms.
  useEffect(() => {
    if (!active) return
    const el = canvasRef.current?.parentElement
    if (!el) return
    const pressed = new Set<number>()
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const sid = sessionRef.current
      if (!sid) return
      const ks = keysymFor(e)
      if (ks == null) return
      e.preventDefault()
      if (down) pressed.add(ks); else pressed.delete(ks)
      void vncKey(sid, down, ks)
    }
    const kd = onKey(true)
    const ku = onKey(false)
    el.addEventListener('keydown', kd)
    el.addEventListener('keyup', ku)
    return () => {
      el.removeEventListener('keydown', kd)
      el.removeEventListener('keyup', ku)
      // Flush key-up for any keys still held, so focus loss doesn't leave a stuck key.
      const sid = sessionRef.current
      if (sid) pressed.forEach(ks => void vncKey(sid, false, ks))
    }
  }, [active])

  return (
    <div className="col" style={{ height: '100%', width: '100%', minHeight: 0, position: 'relative', background: '#0b0b0e' }}>
      <div className="row" style={{ flex: 'none', alignItems: 'center', gap: 10, height: 34, padding: '0 12px', borderBottom: '1px solid var(--border-hairline)', background: 'var(--surface-card)' }}>
        <Icon name="monitor" size={14} style={{ color: 'var(--text-tertiary)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{conn.name}</span>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>VNC {conn.host}:{conn.port ?? 5900}</span>
        <span className="chip" style={{ marginLeft: 'auto', background: status === 'live' ? 'color-mix(in srgb, var(--signal-green) 13%, transparent)' : 'var(--surface-sunken)', color: status === 'live' ? 'var(--signal-green)' : 'var(--text-tertiary)' }}>
          {t(status === 'live' ? 'vnc.connected' : status === 'connecting' ? 'vnc.connecting' : 'vnc.disconnected')}
        </span>
      </div>
      <div tabIndex={0} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none' }}>
        {status === 'error' ? (
          <div className="col" style={{ alignItems: 'center', gap: 10, color: 'var(--text-secondary)' }}>
            <Icon name="alert-triangle" size={22} style={{ color: 'var(--signal-amber)' }} />
            <span style={{ fontSize: 13, maxWidth: 420, textAlign: 'center' }}>{errMsg}</span>
          </div>
        ) : (
          <canvas ref={canvasRef}
            onMouseMove={onMouse} onMouseDown={onMouse} onMouseUp={onMouse}
            onContextMenu={e => e.preventDefault()}
            style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%', cursor: 'crosshair' }} />
        )}
      </div>
    </div>
  )
}
