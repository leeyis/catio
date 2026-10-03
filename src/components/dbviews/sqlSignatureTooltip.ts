import { StateEffect, StateField, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view'
import { closeCompletion } from '@codemirror/autocomplete'
import { sqlFunctionSignatureHelpAt, type SqlFunctionSignatureHelp } from './sqlAdvancedCompletion'

/** Local parameter help, independent from completion selection and DB I/O. */
export function sqlSignatureTooltip(engine: string | undefined, label: string, hint: string): Extension {
  const dismiss = StateEffect.define<boolean>()
  type Value = { help: SqlFunctionSignatureHelp | null; dismissed: string | null }
  const identity = (help: SqlFunctionSignatureHelp | null) => help ? `${help.from}:${help.name}` : null
  const field = StateField.define<Value>({
    create: state => ({ help: sqlFunctionSignatureHelpAt(state, engine), dismissed: null }),
    update(value, transaction) {
      const help = sqlFunctionSignatureHelpAt(transaction.state, engine)
      let dismissed = identity(help) === identity(value.help) ? value.dismissed : null
      for (const effect of transaction.effects) if (effect.is(dismiss)) dismissed = effect.value ? identity(help) : null
      return { help, dismissed }
    },
    provide: f => showTooltip.from(f, value => {
      const help = value.help
      if (!help || value.dismissed === identity(help)) return null
      const tooltip: Tooltip = {
        pos: help.from, above: true,
        create(view) {
          const dom = document.createElement('div')
          dom.className = 'catio-sql-signature'
          dom.setAttribute('role', 'tooltip')
          dom.setAttribute('aria-label', label)
          dom.title = hint
          dom.append(help.name + '(')
          help.parameters.forEach((parameter, index) => {
            if (index) dom.append(help.separator)
            const span = document.createElement('span')
            span.textContent = parameter
            if (index === help.activeParameter) span.dataset.activeParameter = 'true'
            dom.append(span)
          })
          dom.append(')')
          dom.style.display = view.hasFocus ? '' : 'none'
          return { dom, update(update) { dom.style.display = update.view.hasFocus ? '' : 'none' } }
        },
      }
      return tooltip
    }),
  })
  return [field, Prec.highest(keymap.of([
    { key: 'Escape', run: view => {
      const value = view.state.field(field)
      const visible = !!value.help && value.dismissed !== identity(value.help)
      const closed = closeCompletion(view)
      if (visible) view.dispatch({ effects: dismiss.of(true) })
      return visible || closed
    } },
    { key: 'Mod-Shift-Space', run: view => {
      if (!view.state.field(field).help) return false
      view.dispatch({ effects: dismiss.of(false) })
      return true
    } },
  ])), EditorView.baseTheme({
    '.cm-tooltip.catio-sql-signature': {
      padding: '6px 9px', borderRadius: '7px', maxWidth: 'min(520px, 90vw)', whiteSpace: 'normal',
      backgroundColor: 'var(--surface-elevated)', color: 'var(--text-secondary)',
      border: '1px solid var(--border-hairline-alt)', boxShadow: 'var(--shadow-dropdown)',
      fontFamily: 'inherit', fontSize: '12px', lineHeight: '1.6',
    },
    '.catio-sql-signature [data-active-parameter=true]': { fontWeight: '700', color: 'var(--accent-primary)', textDecoration: 'underline' },
  })]
}
