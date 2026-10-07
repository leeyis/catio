import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import './databaseFileFlow.css'

/** Database file flows share layout / focus handling, not execution state or receipts. */
export function DatabaseFileFlow({ title, target, steps, step, busy, onClose, children, footer }: {
  title: string; target: string; steps: string[]; step: number; busy: boolean
  onClose: () => void; children: ReactNode; footer: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId(), body = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => { if (previous?.isConnected && !previous.closest('[hidden]')) previous.focus() }
  }, [])
  useEffect(() => { body.current?.focus() }, [step])
  return createPortal(<div className="db-file-flow-backdrop" data-testid="dbflow-backdrop">
    <div className="db-file-flow pop-in" ref={panel} role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy}
      onKeyDown={event => {
        // Do not let an underlying query console consume execution shortcuts.
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose() }
        if (event.key === 'Tab') {
          const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])]
            .filter(el => !el.closest('[hidden]'))
          const first = controls[0], last = controls.at(-1)
          if (!first) { event.preventDefault(); body.current?.focus(); return }
          if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
      <header className="db-file-flow-header"><div><h2 id={id}>{title}</h2><p className="mono">{target}</p></div>
        <button className="icon-btn bare" aria-label={t('dbviews.close')} title={t('dbviews.close')} disabled={busy} onClick={onClose}><Icon name="x" size={15}/></button>
      </header>
      {steps.length > 0 && <ol className="db-file-flow-steps" aria-label={t('dbflow.steps')}>
        {steps.map((name, index) => <li key={index} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>
          <span aria-hidden="true">{index + 1}</span>{name}
        </li>)}
      </ol>}
      <div className="db-file-flow-body" ref={body} tabIndex={-1}>{children}</div>
      <footer className="db-file-flow-footer">{footer}</footer>
    </div>
  </div>, document.body)
}
