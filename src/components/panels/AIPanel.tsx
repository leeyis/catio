/* ported from ref-ui/_extract/blob9.txt — real streaming chat per plan A2 */
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import { highlightSQL } from '../dbviews'
import { useAgentConfig } from '../../state/agentConfig'
import { chat } from '../../services/agent'
import type { ChatMsg } from '../../services/agent'
import type { Connection } from '../../services/types'
import { PanelShell } from './PanelShell'

export interface Attachment {
  kind: 'sql' | 'shell'
  target: string
  text: string
}

export interface AIPanelProps {
  onClose: () => void
  mode?: 'sql' | 'shell'
  conn?: Connection
  attachment: Attachment | null
  onClearAttachment: () => void
  onInsert?: (code: string) => void
  canInsert?: boolean
  onOpenSettings?: () => void
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

function shellHL(code: string): string {
  let h = code.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  h = h.replace(/('[^']*')/g, '<span style="color:var(--signal-green)">$1</span>')
  h = h.replace(/\b(\d[\d.]*)\b/g, '<span style="color:var(--signal-amber)">$1</span>')
  return h
}

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console'])
const SQL_LANGS = new Set(['sql', 'mysql', 'postgres', 'postgresql', 'pgsql'])

// ---- Shared copy button hook ----
function useCopied() {
  const [copied, setCopied] = useState(false)
  function copy(text: string) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return { copied, copy }
}

// ---- Block code card with action row ----
interface BlockCodeProps {
  lang: string
  code: string
  mode: 'sql' | 'shell'
  onInsert?: (code: string) => void
  canInsert?: boolean
}

function BlockCode({ lang, code, mode, onInsert, canInsert }: BlockCodeProps) {
  const { t } = useTranslation()
  const { copied, copy } = useCopied()
  const isSqlBlock = SQL_LANGS.has(lang) || (lang === '' && mode === 'sql')
  const isShellBlock = SHELL_LANGS.has(lang) || (lang === '' && mode === 'shell')
  const tone = isSqlBlock ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const canInsertShell = isShellBlock && !!onInsert && !!canInsert
  return (
    <div className="col" style={{ border: '1px solid var(--border-hairline)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-card)' }}>
      <div className="row gap6" style={{ padding: '6px 8px 6px 10px', background: 'var(--surface-subtle)', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="dot" style={{ background: tone }} />
        <Icon name={isSqlBlock ? 'database' : 'terminal'} size={12} style={{ color: tone }} />
        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)' }}>{isSqlBlock ? 'SQL' : 'SHELL'}</span>
        <div className="grow" />
        {canInsertShell && (
          <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={t('panels.insertTerminal')} onClick={() => onInsert?.(code)}>
            <Icon name="arrow-right-to-line" size={14} />
          </button>
        )}
        <button className="icon-btn bare" style={{ width: 24, height: 24 }} title={copied ? t('panels.copied') : t('panels.copy')} onClick={() => copy(code)}>
          <Icon name={copied ? 'check' : 'copy'} size={13} style={copied ? { color: 'var(--signal-green)' } : undefined} />
        </button>
      </div>
      <pre className="mono" style={{ margin: 0, padding: '9px 10px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', background: 'var(--surface-subtle)', overflowX: 'auto' }}
        dangerouslySetInnerHTML={{ __html: isSqlBlock ? highlightSQL(code) : shellHL(code) }} />
    </div>
  )
}

// ---- Build react-markdown components with closure over mode/onInsert/canInsert ----
function makeComponents(mode: 'sql' | 'shell', onInsert?: (code: string) => void, canInsert?: boolean): Components {
  return {
    // ---- code: inline vs block detection ----
    // In react-markdown v10 there is no `inline` prop. Block code has className like "language-sh".
    // Inline code has no className. We also treat code with a newline as block.
    code({ className, children, ...rest }) {
      const lang = (className ?? '').replace('language-', '')
      const isBlock = !!className || String(children).includes('\n')
      if (!isBlock) {
        // Inline code
        return (
          <code
            {...rest}
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '12px',
              background: 'var(--surface-sunken)',
              color: 'var(--text-primary)',
              padding: '1px 5px',
              borderRadius: 4,
              border: '1px solid var(--border-hairline)',
            }}
          >
            {children}
          </code>
        )
      }
      const code = String(children).replace(/\n$/, '')
      return <BlockCode lang={lang} code={code} mode={mode} onInsert={onInsert} canInsert={canInsert} />
    },
    // pre: let the code component handle block rendering; pre itself just renders children
    pre({ children }) {
      return <>{children}</>
    },
    // ---- Headings — sized down to fit 13px panel body ----
    h1({ children }) {
      return <h1 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '10px 0 4px', lineHeight: 1.3 }}>{children}</h1>
    },
    h2({ children }) {
      return <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: '8px 0 4px', lineHeight: 1.3 }}>{children}</h2>
    },
    h3({ children }) {
      return <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 3px', lineHeight: 1.3 }}>{children}</h3>
    },
    h4({ children }) {
      return <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: '4px 0 2px', lineHeight: 1.3 }}>{children}</h4>
    },
    // ---- Paragraph ----
    p({ children }) {
      return <p style={{ margin: '6px 0', lineHeight: 1.55, color: 'var(--text-secondary)', fontSize: 13 }}>{children}</p>
    },
    // ---- Lists ----
    ul({ children }) {
      return <ul style={{ margin: '4px 0', paddingLeft: 18, listStyleType: 'disc' }}>{children}</ul>
    },
    ol({ children }) {
      return <ol style={{ margin: '4px 0', paddingLeft: 18, listStyleType: 'decimal' }}>{children}</ol>
    },
    li({ children }) {
      return <li style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', marginBottom: 2 }}>{children}</li>
    },
    // ---- Strong / em ----
    strong({ children }) {
      return <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{children}</strong>
    },
    em({ children }) {
      return <em style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>{children}</em>
    },
    // ---- Links — prevent Tauri webview navigation ----
    a({ href, children }) {
      function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
        e.preventDefault()
        if (href) window.open(href, '_blank', 'noreferrer')
      }
      return (
        <a href={href} onClick={handleClick} rel="noreferrer"
          style={{ color: 'var(--accent-primary)', textDecoration: 'underline', cursor: 'pointer' }}>
          {children}
        </a>
      )
    },
    // ---- Tables (GFM) ----
    table({ children }) {
      return (
        <div style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', color: 'var(--text-secondary)' }}>{children}</table>
        </div>
      )
    },
    th({ children }) {
      return (
        <th style={{ border: '1px solid var(--border-hairline)', padding: '4px 8px', fontWeight: 700, color: 'var(--text-primary)', background: 'var(--surface-subtle)', textAlign: 'left' }}>
          {children}
        </th>
      )
    },
    td({ children }) {
      return <td style={{ border: '1px solid var(--border-hairline)', padding: '4px 8px' }}>{children}</td>
    },
    // ---- Blockquote ----
    blockquote({ children }) {
      return (
        <blockquote style={{ borderLeft: '3px solid var(--border-hairline)', margin: '6px 0', paddingLeft: 10, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
          {children}
        </blockquote>
      )
    },
    // ---- HR ----
    hr() {
      return <hr style={{ border: 'none', borderTop: '1px solid var(--border-hairline)', margin: '8px 0' }} />
    },
  }
}

interface AssistantMessageProps {
  text: string
  mode: 'sql' | 'shell'
  onInsert?: (code: string) => void
  canInsert?: boolean
}

function AssistantMessage({ text, mode, onInsert, canInsert }: AssistantMessageProps) {
  // Memoize components so react-markdown doesn't remount its subtree on every token update.
  // onInsert and canInsert are stable per conversation turn, so this is safe.
  const components = useMemo(
    () => makeComponents(mode, onInsert, canInsert),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, onInsert, canInsert],
  )
  return (
    <div className="col gap4" style={{ maxWidth: '94%' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export function AIPanel({ onClose, mode = 'sql', conn, attachment, onClearAttachment, onInsert, canInsert, onOpenSettings }: AIPanelProps) {
  const { t } = useTranslation()
  const { config: cfg } = useAgentConfig()
  const isSql = mode !== 'shell'
  const target = conn ? conn.name : (isSql ? 'prod-orders' : 'prod-web-01')
  const accent = isSql ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const [draft, setDraft] = useState('')
  const [msgs, setMsgs] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => { if (attachment && taRef.current) taRef.current.focus() }, [attachment])
  useEffect(() => () => { abortRef.current?.abort() }, [])
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [msgs])

  async function send() {
    const text = draft.trim()
    if (!text || !cfg.model || busy) return

    let userContent = text
    if (attachment) {
      userContent += `\n\n---\n${attachment.text}`
      onClearAttachment()
    }

    const system: ChatMsg = {
      role: 'system',
      content: `You are a terminal/shell assistant for host "${conn?.name ?? target}". When you suggest a shell command, put it in a fenced code block.`,
    }
    const prior: ChatMsg[] = msgs.map(m => ({ role: m.role, content: m.content }))
    const outgoing: ChatMsg[] = [system, ...prior, { role: 'user', content: userContent }]

    setMsgs(m => [...m, { role: 'user', content: userContent }, { role: 'assistant', content: '' }])
    setDraft('')
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      await chat(outgoing, cfg, {
        signal: controller.signal,
        onToken: tok => setMsgs(m => {
          const n = [...m]
          const lastIdx = n.length - 1
          n[lastIdx] = { ...n[lastIdx], content: n[lastIdx].content + tok }
          return n
        }),
      })
    } catch (err) {
      if (controller.signal.aborted) return
      const message = (err as { message?: string } | null)?.message ?? String(err)
      setMsgs(m => {
        const n = [...m]
        const lastIdx = n.length - 1
        n[lastIdx] = { ...n[lastIdx], content: t('panels.agentError', { message }) }
        return n
      })
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <PanelShell icon="sparkles" title="Catio Agent"
      sub={isSql ? t('panels.sqlAssistantSub', { target }) : t('panels.shellAssistantSub', { target })}
      onClose={onClose}
      actions={<IconBtn name="history" size={15} variant="bare" title={t('panels.sessionHistory')} />}>
      {/* scope banner — strictly follows the active workbench tab */}
      <div className="row gap8" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
        <span className="chip" style={{ background: `color-mix(in srgb, ${accent} 15%, transparent)`, color: accent, fontWeight: 600 }}>
          <Icon name={isSql ? 'database' : 'terminal'} size={11} /> {isSql ? t('panels.sqlMode') : t('panels.shellMode')}
        </span>
        <span className="row gap5" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <Icon name="link" size={11} style={{ color: 'var(--text-faint)' }} />
          <span>{t('panels.followActiveTab', { target })}</span>
        </span>
      </div>
      {/* message area */}
      {!cfg.model ? (
        <div className="grow col" style={{ alignItems: 'center', justifyContent: 'center', gap: 14, padding: '24px 28px', textAlign: 'center' }}>
          <div className="icon-badge" style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}><Icon name="box" size={22} /></div>
          <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>{t('panels.agentNoModel')}</span>
          <button className="btn btn-primary sm" onClick={() => onOpenSettings?.()}><Icon name="settings" size={14} /> {t('panels.agentConfigure')}</button>
        </div>
      ) : (
        <div ref={scrollRef} className="grow" style={{ overflowY: 'auto', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {msgs.map((m, i) => m.role === 'user'
            ? <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--accent-primary)', color: 'var(--on-accent)', padding: '9px 12px', borderRadius: '14px 14px 4px 14px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{m.content}</div>
            : <AssistantMessage key={i} text={m.content} mode={mode} onInsert={onInsert} canInsert={canInsert} />)}
          {busy && msgs.length > 0 && msgs[msgs.length - 1].content === '' && (
            <div className="row gap6" style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              <Icon name="loader" size={13} style={{ animation: 'spin 1s linear infinite' }} /> {t('panels.agentThinking')}
            </div>
          )}
        </div>
      )}
      {/* composer */}
      <div style={{ padding: 10, borderTop: '1px solid var(--border-hairline)' }}>
        {/* attached terminal/SQL output — piped in via "问 AI" */}
        {attachment && (
          <div className="col pop-in" style={{ border: '1px solid var(--accent-border)', background: 'var(--accent-soft-alt)', borderRadius: 11, padding: '8px 10px', marginBottom: 8 }}>
            <div className="row gap6" style={{ marginBottom: 5 }}>
              <Icon name={attachment.kind === 'sql' ? 'database' : 'terminal'} size={12} style={{ color: 'var(--accent-primary)' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-primary)' }}>{t('panels.attachedOutput', { target: attachment.target })}</span>
              <span className="grow" />
              <button className="icon-btn bare" style={{ width: 20, height: 20 }} title={t('panels.removeAttachment')} onClick={onClearAttachment}><Icon name="x" size={12} /></button>
            </div>
            <pre className="mono" style={{ margin: 0, fontSize: 10.8, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 92, overflowY: 'auto', wordBreak: 'break-all' }}>{attachment.text}</pre>
          </div>
        )}
        <div className="col" style={{ background: 'var(--surface-sunken)', border: `1px solid ${attachment ? 'var(--accent-border)' : 'var(--border-hairline)'}`, borderRadius: 12, padding: 8 }}>
          <textarea ref={taRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
            placeholder={attachment ? t('panels.composerPlaceholderAttached') : (isSql ? t('panels.composerPlaceholderSql') : t('panels.composerPlaceholderShell', { target }))}
            rows={2} style={{ border: 'none', outline: 'none', background: 'transparent', resize: 'none', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'inherit' }} />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <div className="row gap4">
              <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('panels.attachContext')}><Icon name="plus" size={15} /></button>
              <button className="icon-btn bare" style={{ width: 26, height: 26 }} title={t('panels.selectModel')} onClick={() => onOpenSettings?.()}><Icon name="box" size={14} /></button>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', alignSelf: 'center' }}>{cfg.model || t('panels.modelInfo')}</span>
            </div>
            <button className="btn btn-primary sm" style={{ width: 32, padding: 0 }} title={t('panels.send')} disabled={busy || !cfg.model || !draft.trim()} onClick={() => void send()}><Icon name="send" size={14} /></button>
          </div>
        </div>
      </div>
    </PanelShell>
  )
}
