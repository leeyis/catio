import {EditorView} from '@codemirror/view'

/** SQL-only density and diagnostics. Keep the shared remote-file editor theme
 * and the plain-mode (Redis/Mongo/ES) gutter unchanged. */
export const sqlEditorTheme=EditorView.theme({
  '.cm-content':{paddingLeft:'4px',paddingRight:'4px'},
  '.cm-tooltip':{
    backgroundColor:'var(--surface-elevated)',color:'var(--text-primary)',
    border:'1px solid var(--border-hairline-alt)',borderRadius:'8px',boxShadow:'var(--shadow-dropdown)',
  },
  '.cm-tooltip-lint':{
    maxWidth:'min(440px, calc(100vw - 32px))',maxHeight:'240px',overflowY:'auto',
    fontFamily:'inherit',fontSize:'12px',fontWeight:'400',lineHeight:'1.6',
  },
  '.cm-diagnostic':{
    padding:'7px 10px',marginLeft:'0',borderLeft:'none',whiteSpace:'normal',overflowWrap:'anywhere',
  },
  '.cm-diagnosticSource':{color:'var(--text-tertiary)',fontSize:'11px',opacity:'1',marginTop:'3px'},
  '.cm-diagnosticAction':{
    background:'var(--accent-soft-alt)',color:'var(--accent-primary)',
    border:'1px solid var(--accent-border)',borderRadius:'4px',padding:'2px 6px',
  },
  '.cm-diagnosticAction:hover':{background:'var(--accent-soft)'},
  '.cm-diagnosticAction:focus-visible':{outline:'2px solid var(--accent-primary)',outlineOffset:'2px'},
  '.cm-lintRange-error':{backgroundImage:'none',textDecoration:'underline wavy var(--danger-fg)',textUnderlineOffset:'3px'},
  '.cm-lintRange-warning':{backgroundImage:'none',textDecoration:'underline wavy var(--signal-amber)',textUnderlineOffset:'3px'},
  '.cm-panel.cm-panel-lint':{background:'var(--surface-subtle)',color:'var(--text-primary)',fontSize:'12px',fontWeight:'400',lineHeight:'1.6'},
  '.cm-panel.cm-panel-lint ul [aria-selected], .cm-panel.cm-panel-lint ul:focus [aria-selected]':{background:'var(--accent-soft-alt)',color:'var(--text-primary)'},
  '.cm-panel.cm-panel-lint [name=close]':{color:'var(--text-secondary)',width:'20px',height:'20px',fontSize:'14px'},
  '.cm-panel.cm-panel-lint [name=close]:focus-visible':{outline:'2px solid var(--accent-primary)',outlineOffset:'-2px'},
  '.cm-panel.cm-panel-lint .cm-diagnostic':{paddingRight:'24px'},
})
