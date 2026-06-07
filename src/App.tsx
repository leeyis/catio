/* ported from ref-ui/_extract/blob15.txt — verbatim per plan T1-T7 */
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TitleBar, Sidebar, IconRail } from './components/shell/Sidebar'
import { HomeView } from './components/views/HomeView'
import { SettingsView } from './components/views/SettingsView'
import { WorkbenchTabs } from './components/workbench/WorkbenchTabs'
import { TerminalPane } from './components/workbench/TerminalPane'
import { DbWorkbench } from './components/workbench/DbWorkbench'
import { AIPanel } from './components/panels/AIPanel'
import { SftpPanel } from './components/panels/SftpPanel'
import { MonitorPanel } from './components/panels/MonitorPanel'
import { TunnelsPanel } from './components/panels/TunnelsPanel'
import { SnippetsPanel } from './components/panels/SnippetsPanel'
import { HistoryPanel } from './components/panels/HistoryPanel'
import { DetailsPanel } from './components/panels/DetailsPanel'
import { NewConnectionModal } from './components/modals/NewConnectionModal'
import { AuthGate } from './components/auth/AuthGate'
import { Icon } from './components/Icon'
import { Btn } from './components/atoms'
import { useTweaks, TWEAK_DEFAULTS } from './state/useTweaks'
import { nextTheme, useApplyTheme } from './state/ThemeContext'
import { useData } from './state/DataContext'
import type { Tab, Connection, Snippet } from './services/types'
import type { AuthUser } from './components/auth/AuthGate'
import type { Attachment } from './components/panels/AIPanel'

export default function App() {
  const D = useData()
  const hash = (location.hash || '').replace('#', '')
  const initTheme = hash.includes('amber') ? 'amber' : hash.includes('grove') ? 'grove' : ((localStorage.getItem('catio-theme') || 'dawn') as 'dawn' | 'amber' | 'grove')
  const initView = (['home', 'workbench', 'settings'] as const).find(v => hash.includes(v)) || 'home'
  const [tweaks, setTweak] = useTweaks({ ...TWEAK_DEFAULTS, theme: initTheme })
  const [view, setView] = useState<string>(initView)
  const [prevView, setPrevView] = useState<string>('home')
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'tab-bastion', kind: 'terminal', connId: 'h-bastion', title: 'db-bastion' },
    { id: 'tab-orders', kind: 'sql', connId: 'd-orders', title: 'prod-orders · orders' },
  ])
  const [activeTab, setActiveTab] = useState<string>(hash.includes('term') ? 'tab-bastion' : 'tab-orders')
  const [activePanel, setActivePanel] = useState<string>('ai')
  const [panelOpen, setPanelOpen] = useState<boolean>(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  const [detailConn, setDetailConn] = useState<Connection | null>(null)
  const [showNew, setShowNew] = useState<boolean>(false)
  const [aiAttachment, setAiAttachment] = useState<Attachment | null>(null)
  const [snippets, setSnippets] = useState<Snippet[]>(() => D.snippets)

  function addSnippet(s: Snippet) {
    setSnippets(prev => [{ ...s, id: 's' + Date.now() }, ...prev])
    setActivePanel('snippets')
    setPanelOpen(true)
  }

  // ---- local multi-user auth ----
  const [authEnabled, setAuthEnabled] = useState<boolean>(() => localStorage.getItem('catio-auth') === '1')
  const [users, setUsers] = useState<AuthUser[]>(() => {
    try { return JSON.parse(localStorage.getItem('catio-users') || '[]') } catch (e) { return [] }
  })
  const [ownerUser, setOwnerUser] = useState<string>(() => localStorage.getItem('catio-owner') || '')
  const [sessionUser, setSessionUser] = useState<string | null>(() =>
    sessionStorage.getItem('catio-session') || (localStorage.getItem('catio-auth') === '1' ? null : '__open')
  )

  const locked = authEnabled && !sessionUser
  // the first account created owns the seed vault; other users get an isolated (empty) vault
  const ownsVault = !authEnabled || sessionUser === ownerUser || sessionUser === '__open'
  const vaultConns = ownsVault ? D.connections : []
  const currentName = authEnabled && sessionUser && sessionUser !== '__open' ? sessionUser : 'skyler'

  function enableAuth() {
    localStorage.setItem('catio-auth', '1')
    setAuthEnabled(true)
    setSessionUser(null)
    sessionStorage.removeItem('catio-session')
  }
  function disableAuth() {
    localStorage.removeItem('catio-auth')
    setAuthEnabled(false)
    setSessionUser('__open')
  }
  function lockApp() {
    setSessionUser(null)
    sessionStorage.removeItem('catio-session')
  }
  function loginUser(name: string) {
    setSessionUser(name)
    sessionStorage.setItem('catio-session', name)
  }
  function createUser(user: AuthUser) {
    const next = [...users, user]
    setUsers(next)
    localStorage.setItem('catio-users', JSON.stringify(next))
    if (!ownerUser) {
      setOwnerUser(user.username)
      localStorage.setItem('catio-owner', user.username)
    }
    loginUser(user.username)
  }

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Attachment>).detail
      setAiAttachment(detail)
      setActivePanel('ai')
      setPanelOpen(true)
    }
    window.addEventListener('catio-ask-ai', handler)
    return () => window.removeEventListener('catio-ask-ai', handler)
  }, [])

  const theme_ = tweaks.theme
  const density = tweaks.density
  const aiForm = tweaks.aiForm
  const panelW = tweaks.panelW

  useApplyTheme(theme_, panelW)

  const setThemeBoth = (x: string) => setTweak('theme', x as 'dawn' | 'amber' | 'grove')

  function openConn(conn: Connection) {
    const isHost = conn.kind === 'host'
    const tabId = (isHost ? 'tab-' : 'tab-') + conn.id
    setTabs(prev => prev.some(t => t.id === tabId) ? prev : [...prev, {
      id: tabId,
      kind: isHost ? 'terminal' : 'sql',
      connId: conn.id,
      title: isHost ? conn.name : conn.name + ' · orders',
    }])
    setActiveTab(tabId)
    setView('workbench')
  }
  function closeTab(id: string) {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        setView('home') // no sessions left → back to home automatically
      } else if (activeTab === id) {
        setActiveTab(next[next.length - 1].id)
      }
      return next
    })
  }
  function openDetail(conn: Connection) {
    setDetailConn(conn)
    setActivePanel('details')
    setPanelOpen(true)
  }
  function selectPanel(id: string) {
    if (activePanel === id && panelOpen) { setPanelOpen(false) }
    else { setActivePanel(id); setPanelOpen(true) }
  }
  function goSettings() {
    if (view !== 'settings') setPrevView(view)
    setView(view === 'settings' ? prevView : 'settings')
  }

  const cur = tabs.find(t => t.id === activeTab)
  const curConn = cur ? D.byId[cur.connId] : null
  const aiMode = cur && cur.kind === 'terminal' ? 'shell' : 'sql'

  return (
    <div className="win">
      <TitleBar theme={theme_} onToggleTheme={() => setThemeBoth(nextTheme(theme_))}
        onOpenSettings={goSettings} settingsActive={view === 'settings'} onSearch={() => {}} />

      {view === 'settings' ? (
        <SettingsView theme={theme_} onTheme={setThemeBoth} onClose={() => setView(prevView)}
          authEnabled={authEnabled} users={users} currentUser={currentName} ownerUser={ownerUser}
          onEnableAuth={enableAuth} onDisableAuth={disableAuth} onLock={lockApp} onRemoveUser={(name: string) => {
            const next = users.filter(x => x.username !== name)
            setUsers(next)
            localStorage.setItem('catio-users', JSON.stringify(next))
          }} />
      ) : (
        <div className="body">
          <Sidebar activeId={cur ? cur.connId : undefined} onOpen={openConn} onDetail={openDetail} onNew={() => setShowNew(true)}
            collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(c => !c)}
            conns={vaultConns} currentUser={currentName} authEnabled={authEnabled} onLock={lockApp} />

          {/* main */}
          <div className="card-surface grow col" style={{ overflow: 'hidden', position: 'relative' }}>
            {/* view body */}
            <div className="grow col" style={{ minHeight: 0 }}>
              {view === 'home' && <HomeView onOpen={openConn} onNew={() => setShowNew(true)} onVault={() => setView('workbench')} owned={ownsVault} userName={currentName} />}
              {view === 'workbench' && (
                tabs.length ? (
                  <>
                    <WorkbenchTabs tabs={tabs} activeTab={activeTab} onActivate={setActiveTab} onClose={closeTab} onNew={() => setShowNew(true)} />
                    <div className="grow" style={{ minHeight: 0 }}>
                      {cur && cur.kind === 'terminal' && <TerminalPane conn={curConn} key={cur.id} />}
                      {cur && cur.kind === 'sql' && curConn && <DbWorkbench conn={curConn} density={density} key={cur.id} />}
                    </div>
                  </>
                ) : <EmptyWorkbench onNew={() => setShowNew(true)} />
              )}
            </div>

            {/* AI floating / bar forms render inside main */}
            {aiForm === 'floating' && <AIFloating mode={aiMode} conn={curConn} />}
            {aiForm === 'bar' && <AICommandBar mode={aiMode} conn={curConn} />}
          </div>

          {/* panel slot */}
          {panelOpen && (aiForm === 'side' || activePanel !== 'ai') && (
            <div className="fade-in" style={{ display: 'flex' }}>
              {activePanel === 'ai' && <AIPanel onClose={() => setPanelOpen(false)} mode={aiMode} conn={curConn ?? undefined} attachment={aiAttachment} onClearAttachment={() => setAiAttachment(null)} />}
              {activePanel === 'sftp' && <SftpPanel onClose={() => setPanelOpen(false)} />}
              {activePanel === 'monitor' && <MonitorPanel onClose={() => setPanelOpen(false)} />}
              {activePanel === 'tunnels' && <TunnelsPanel onClose={() => setPanelOpen(false)} />}
              {activePanel === 'snippets' && <SnippetsPanel onClose={() => setPanelOpen(false)} snippets={snippets} />}
              {activePanel === 'history' && <HistoryPanel onClose={() => setPanelOpen(false)} onAddSnippet={addSnippet} />}
              {activePanel === 'details' && <DetailsPanel conn={detailConn ?? undefined} onClose={() => setPanelOpen(false)} />}
            </div>
          )}

          {/* icon rail */}
          <IconRail active={activePanel} onSelect={selectPanel} panelOpen={panelOpen} />
        </div>
      )}

      {showNew && <NewConnectionModal onClose={() => setShowNew(false)} />}

      {locked && <AuthGate users={users} onLogin={loginUser} onCreate={createUser} />}
    </div>
  )
}

// ---- EmptyWorkbench ----

interface EmptyWorkbenchProps {
  onNew: () => void
}

function EmptyWorkbench({ onNew }: EmptyWorkbenchProps) {
  const { t } = useTranslation()
  return (
    <div className="col" style={{ alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, color: 'var(--text-faint)' }}>
      <div className="icon-badge" style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--surface-sunken)' }}><Icon name="terminal-square" size={26} /></div>
      <div className="col" style={{ alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('app.noSessions')}</span>
        <span style={{ fontSize: 12.5 }}>{t('app.noSessionsHint')}</span>
      </div>
      <Btn variant="cta" icon="plus" onClick={onNew}>{t('common.newConnection')}</Btn>
    </div>
  )
}

// ---- AI alternate forms ----

interface AIFloatingProps {
  mode: 'sql' | 'shell'
  conn: Connection | null
}

function AIFloating({ mode, conn }: AIFloatingProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isSql = mode !== 'shell'
  return (
    <div style={{ position: 'absolute', right: 18, bottom: 18, zIndex: 40 }}>
      {open ? (
        <div className="pop-in card-surface col" style={{ width: 360, height: 480, boxShadow: 'var(--shadow-window)' }}>
          <AIPanelInner onClose={() => setOpen(false)} mode={mode} conn={conn} />
        </div>
      ) : (
        <button className="btn btn-cta lg" onClick={() => setOpen(true)} style={{ boxShadow: 'var(--shadow-window)', borderRadius: 999, height: 48 }}>
          <Icon name="sparkles" size={18} /> {isSql ? t('app.sqlAssistant') : t('app.shellAssistant')}
        </button>
      )}
    </div>
  )
}

interface AIPanelInnerProps {
  onClose: () => void
  mode: 'sql' | 'shell'
  conn: Connection | null
}

function AIPanelInner({ onClose, mode, conn }: AIPanelInnerProps) {
  // reuse AIPanel content but without fixed width wrapper
  return (
    <div style={{ display: 'contents' }}>
      <AIPanel onClose={onClose} mode={mode} conn={conn ?? undefined} attachment={null} onClearAttachment={() => {}} />
    </div>
  )
}

interface AICommandBarProps {
  mode: 'sql' | 'shell'
  conn: Connection | null
}

function AICommandBar({ mode, conn }: AICommandBarProps) {
  const { t } = useTranslation()
  const [v, setV] = useState('')
  const isSql = mode !== 'shell'
  const tone = isSql ? 'var(--signal-blue)' : 'var(--signal-amber)'
  const target = conn ? conn.name : (isSql ? 'prod-orders' : 'prod-web-01')
  return (
    <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 16, zIndex: 40, width: 'min(680px, 80%)' }}>
      <div className="row gap8 pop-in" style={{ background: 'var(--surface-card)', border: '1px solid var(--accent-border)', borderRadius: 14, padding: '8px 10px 8px 14px', boxShadow: 'var(--shadow-window)' }}>
        <Icon name="sparkles" size={17} style={{ color: 'var(--accent-primary)' }} />
        <input value={v} onChange={e => setV(e.target.value)}
          placeholder={isSql ? t('app.cmdBarSqlPlaceholder', { target }) : t('app.cmdBarShellPlaceholder', { target })}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, color: 'var(--text-primary)' }} />
        <span className="chip" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone, fontWeight: 600 }}><Icon name={isSql ? 'database' : 'terminal'} size={11} /> {isSql ? 'SQL' : 'Shell'} · {target}</span>
        <button className="btn btn-primary sm" style={{ width: 32, padding: 0 }}><Icon name="send" size={14} /></button>
      </div>
    </div>
  )
}
