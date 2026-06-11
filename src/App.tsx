/* ported from ref-ui/_extract/blob15.txt — verbatim per plan T1-T7 */
import { useState, useEffect, useRef } from 'react'
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
import { ConnectSecretPrompt } from './components/modals/ConnectSecretPrompt'
import { HostKeyPrompt } from './components/modals/HostKeyPrompt'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { AlertModal } from './components/modals/AlertModal'
import { ConnectingOverlay } from './components/modals/ConnectingOverlay'
import { AuthGate } from './components/auth/AuthGate'
import { Icon } from './components/Icon'
import { Btn } from './components/atoms'
import { useTweaks, TWEAK_DEFAULTS } from './state/useTweaks'
import { nextTheme, useApplyTheme } from './state/ThemeContext'
import { usePrefs, uiFontStack, monoFontStack } from './state/preferences'
import { readTermBufferTail } from './services/termBuffers'
import { useData } from './state/DataContext'
import { dbConnect, dbDisconnect, getHistory as getDbHistory, clearDbHistory, deleteDbHistory, dbErrMsg } from './services/db'
import {
  useDbConnections, dbProfileToConnection, listActiveDbConnections,
  setActiveDbConnection, removeDbConnection, removeActiveDbConnection,
  type DbProfile,
} from './state/dbConnections'
import { sshConnect, sshDisconnect, sshTrustHost, isTauri, onHistory, sshSysinfo, sshDetectOs, importSshConfig } from './services/ssh'
import type { SshConnectArgs, AuthMethod } from './services/ssh'
import { mcpSyncTargets } from './services/mcp'
import { createVaultCredential, unlockVault, lockVault, isVaultUnlocked, recallSecret, rememberSecret } from './state/vault'
import { appendHistory, loadHistory, clearHistory, deleteHistory } from './state/history'
import { loadRecentSessions, recordRecentSession } from './state/recentSessions'
import type { HistoryItem } from './services/types'
import { loadProfiles, saveProfile, deleteProfile } from './state/connections'
import { loadSnippets, saveSnippet, newSnippetId } from './state/snippets'
import {
  loadConversations,
  saveConversation,
  deleteConversation as deleteConversationStore,
  conversationsForHost,
  newConversation as makeConversation,
} from './state/conversations'
import type { Conversation } from './state/conversations'
import { chat } from './services/agent'
import type { ChatMsg } from './services/agent'
import { useAgentConfig } from './state/agentConfig'
import type { ConnectionProfile } from './state/connections'
import type { Tab, Connection, Snippet } from './services/types'
import type { AuthUser } from './components/auth/AuthGate'
import type { Attachment } from './components/panels/AIPanel'

export default function App() {
  const D = useData()
  const dbProfiles = useDbConnections()
  // Active DB connections live in a module-level Map (not React state). Bump this
  // to force a re-render when a connection is opened/closed so the vault status
  // and the details panel reflect the change.
  const [, setDbActiveRev] = useState(0)
  const bumpDbActive = () => setDbActiveRev(x => x + 1)
  const { t } = useTranslation()
  const hash = (location.hash || '').replace('#', '')
  const initTheme = hash.includes('amber') ? 'amber' : hash.includes('grove') ? 'grove' : ((localStorage.getItem('catio-theme') || 'dawn') as 'dawn' | 'amber' | 'grove')
  const initView = (['home', 'workbench', 'settings'] as const).find(v => hash.includes(v)) || 'home'
  const [tweaks, setTweak] = useTweaks({ ...TWEAK_DEFAULTS, theme: initTheme })
  const [view, setView] = useState<string>(initView)
  const [prevView, setPrevView] = useState<string>('home')
  // Which Settings section to open to (theme | security | ai | ...).
  const [settingsSection, setSettingsSection] = useState<string>('appearance')
  // Start with no open tabs — the app lands on 'home' by default (clean, no
  // auto-opened mock host/db). Tabs are created on demand by openConn/openLiveTab.
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTab, setActiveTab] = useState<string>('')
  const [activePanel, setActivePanel] = useState<string>('ai')
  const [panelOpen, setPanelOpen] = useState<boolean>(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  const [detailConn, setDetailConn] = useState<Connection | null>(null)
  const [showNew, setShowNew] = useState<boolean>(false)
  // EDIT mode for the DB NewConnectionModal (null = create/new DB profile).
  const [editProfile, setEditProfile] = useState<DbProfile | null>(null)
  // Sidebar vault filter: all | host | db.
  const [sidebarFilter, setSidebarFilter] = useState<string>('all')
  // EDIT mode for the SSH NewConnectionModal (null = create/new host profile).
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)
  // Pending delete confirmation (styled ConfirmModal).
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const [aiAttachment, setAiAttachment] = useState<Attachment | null>(null)
  const [snippets, setSnippets] = useState<Snippet[]>(() => loadSnippets())

  // ---- Catio Agent conversations (P2): per-host persisted, per-tab current ----
  const { config: agentCfg } = useAgentConfig()
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  // Authoritative mirror of `conversations` for mutations/persistence. React 18
  // does not guarantee a setState updater runs synchronously during streaming,
  // so we never rely on the updater's return value to persist — we mutate this
  // ref synchronously, persist from it, then push it into state for rendering.
  const conversationsRef = useRef<Conversation[]>(conversations)
  // tabId -> the conversation id currently shown for that tab.
  const [currentConvByTab, setCurrentConvByTab] = useState<Record<string, string>>({})
  // tabId -> AbortController for the in-flight send (so streaming survives view/tab switches).
  const agentAborts = useRef<Record<string, AbortController>>({})
  // convIds with a live in-flight stream (drives the panel's busy state).
  const [busyConvs, setBusyConvs] = useState<Record<string, boolean>>({})
  // sessionId -> cached sysinfo string (fetched once per session on first agent send).
  const sysinfoCache = useRef<Record<string, string>>({})

  // Upsert into the ref (source of truth), localStorage, and render state.
  function upsertConversation(conv: Conversation) {
    const next = [...conversationsRef.current.filter(c => c.id !== conv.id), conv]
    conversationsRef.current = next
    setConversations(next)
    saveConversation(conv)
  }

  // Real saved connection profiles (localStorage) — these seed the Vault & Home.
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(() => loadProfiles())
  const reloadProfiles = () => setProfiles(loadProfiles())

  // ---- ORCH: live SSH session orchestration ----
  // connId -> sessionId for live (Tauri) connections.
  const [sessionMap, setSessionMap] = useState<Record<string, string>>({})
  // Display Connection objects for live conns (not present in mock D.byId).
  const [liveConns, setLiveConns] = useState<Record<string, Connection>>({})
  // sessionId -> live PTY channel id (surfaced by TerminalPane.onChannel). Used to
  // write snippet/history "insert" payloads into the active terminal.
  const [chanMap, setChanMap] = useState<Record<string, string>>({})
  // History items loaded from localStorage; updated on each new audit event.
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory())
  // DB query history (backend file), fetched when the History panel is open. Merged
  // with the SSH command history into one timeline for the unified panel.
  const [dbHistory, setDbHistory] = useState<HistoryItem[]>([])
  // Recently-opened connections (for the home "最近会话" section), newest-first.
  const [recentSessions, setRecentSessions] = useState(() => loadRecentSessions())
  // Refresh DB history whenever the History panel is opened. Map the recorded
  // backend connId → a friendly connection name (when the conn is still active)
  // so the panel's per-connection filter shows real names.
  useEffect(() => {
    if (!(activePanel === 'history' && panelOpen)) return
    const nameByConnId: Record<string, string> = Object.fromEntries(
      listActiveDbConnections().map(a => [a.connId, a.name]),
    )
    getDbHistory('')
      .then(items => setDbHistory(items.map(h => ({ ...h, target: nameByConnId[h.target] ?? h.target }))))
      .catch(() => setDbHistory([]))
  }, [activePanel, panelOpen])
  // Unified, newest-first timeline (SSH commands + DB queries).
  const mergedHistory = [...history, ...dbHistory].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  // sessionId -> unlisten fn for history:// subscriptions; avoids re-render on update.
  const historyUnlisteners = useRef<Record<string, () => void>>({})
  // Per-event idempotency: a single backend command must produce exactly one row
  // even if multiple listeners observe the same history:// event. Bounded below.
  const seenHistIds = useRef<Set<string>>(new Set())
  // Connect-flow state machine: collect secret, then (maybe) trust host key.
  // pendingJumpSecret: when a profile has a jump host, collect jump secret first.
  const [pendingJumpSecret, setPendingJumpSecret] = useState<{ args: SshConnectArgs; name: string; profileId?: string } | null>(null)
  const [pendingConnect, setPendingConnect] = useState<{ args: SshConnectArgs; name: string; profileId?: string } | null>(null)
  const [pendingTrust, setPendingTrust] = useState<{ args: SshConnectArgs; name: string; sessionId: string; fingerprint: string } | null>(null)
  // Connect feedback: host name while a connect is in flight (shows an overlay so
  // there's immediate feedback instead of a 1–2s silent gap), and a styled in-app
  // error dialog (replaces the jarring native window.alert).
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  // DB connect-with-password prompt (opened directly from a DB card's 连接 button,
  // mirroring the SSH host prompt — no detour through the details panel).
  const [pendingDbConnect, setPendingDbConnect] = useState<DbProfile | null>(null)
  const [dbPromptError, setDbPromptError] = useState<string | null>(null)
  const [dbPromptBusy, setDbPromptBusy] = useState(false)
  const resolveSessionId = (connId: string) => sessionMap[connId]

  function addSnippet(s: Snippet) {
    saveSnippet({ ...s, id: newSnippetId() })
    setSnippets(loadSnippets())
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
  // Vault = real saved SSH host profiles + real saved DB connections (reactive).
  // Mock DB connections are excluded — only real saved profiles drive DB rows now.
  // Real saved SSH host profiles (localStorage) → host Connection rows.
  const profileConns: Connection[] = profiles.map(p => ({
    id: p.id,
    group: p.group ?? '',
    kind: 'host',
    name: p.name,
    sub: `${p.user}@${p.host}:${p.port}`,
    icon: 'server',
    status: 'idle',
    proto: 'ssh',
    ...(p.os ? { os: p.os } : {}),
  }))
  // Real saved DB connections (reactive) → db Connection rows.
  const activeProfileIds = new Set(listActiveDbConnections().map(a => a.profileId))
  const realDbConns = dbProfiles.map(p => dbProfileToConnection(p, activeProfileIds.has(p.id)))
  const vaultConns = ownsVault ? [...profileConns, ...realDbConns] : []
  const currentName = authEnabled && sessionUser && sessionUser !== '__open' ? sessionUser : 'skyler'

  function enableAuth() {
    localStorage.setItem('catio-auth', '1')
    setAuthEnabled(true)
    setSessionUser(null)
    sessionStorage.removeItem('catio-session')
  }
  function disableAuth() {
    lockVault()
    localStorage.removeItem('catio-auth')
    setAuthEnabled(false)
    setSessionUser('__open')
  }
  function lockApp() {
    lockVault()
    setSessionUser(null)
    sessionStorage.removeItem('catio-session')
  }
  // Verify the password, unlock the encrypted secret vault, and start a session.
  // Legacy plaintext-password records are migrated to an encrypted credential
  // on first successful login. Returns false on a wrong password.
  async function loginUser(name: string, password: string): Promise<boolean> {
    const found = users.find(x => x.username === name)
    if (!found) return false
    if (found.salt && found.verifier && found.iv) {
      const ok = await unlockVault(password, { salt: found.salt, verifier: found.verifier, iv: found.iv })
      if (!ok) return false
    } else if (found.pass !== undefined) {
      if (found.pass !== password) return false
      const cred = await createVaultCredential(password)
      const upgraded: AuthUser = { username: found.username, hint: found.hint, ...cred }
      const next = users.map(x => (x.username === found.username ? upgraded : x))
      setUsers(next)
      localStorage.setItem('catio-users', JSON.stringify(next))
    } else {
      return false
    }
    setSessionUser(name)
    sessionStorage.setItem('catio-session', name)
    return true
  }
  async function createUser(input: { username: string; password: string; hint: string }) {
    const cred = await createVaultCredential(input.password)
    const user: AuthUser = { username: input.username, hint: input.hint, ...cred }
    const next = [...users, user]
    setUsers(next)
    localStorage.setItem('catio-users', JSON.stringify(next))
    if (!ownerUser) {
      setOwnerUser(user.username)
      localStorage.setItem('catio-owner', user.username)
    }
    setSessionUser(user.username)
    sessionStorage.setItem('catio-session', user.username)
  }

  // ---- encrypted connection-secret cache (auth-gated) ----
  // Recall a cached secret only when auth is on AND the vault is unlocked.
  async function cachedSecret(profileId: string): Promise<string | null> {
    if (!authEnabled || !sessionUser || sessionUser === '__open' || !isVaultUnlocked()) return null
    return recallSecret(sessionUser, profileId)
  }
  function rememberConnSecret(profileId: string, secret: string) {
    if (authEnabled && sessionUser && sessionUser !== '__open' && isVaultUnlocked() && secret) {
      void rememberSecret(sessionUser, profileId, secret)
    }
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

  // ---- MCP server: mirror active DB + SSH connections to the backend registry
  // so its tools can resolve targets by name. ----
  function syncMcpTargets() {
    const databases = listActiveDbConnections().map(a => ({ connId: a.connId, name: a.name, dbType: a.dbType }))
    const hosts = Object.entries(sessionMap)
      .map(([connId, sessionId]) => ({ sessionId, name: liveConns[connId]?.name ?? connId, host: liveConns[connId]?.sub ?? '' }))
      .filter(h => h.sessionId)
    void mcpSyncTargets(databases, hosts)
  }
  useEffect(() => {
    syncMcpTargets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbProfiles, sessionMap, liveConns])

  const theme_ = tweaks.theme
  const aiForm = tweaks.aiForm
  const panelW = tweaks.panelW

  // Appearance prefs (fonts / terminal size / density) — persisted + live across
  // components via the subscribable store, so a change in Settings applies at once.
  const { prefs } = usePrefs()
  const density = prefs.density
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font', uiFontStack(prefs.uiFont))
    document.documentElement.style.setProperty('--font-mono', monoFontStack(prefs.monoFont))
  }, [prefs.uiFont, prefs.monoFont])

  useApplyTheme(theme_, panelW)

  const setThemeBoth = (x: string) => setTweak('theme', x as 'dawn' | 'amber' | 'grove')

  // Build a display Connection for a live SSH session and open its terminal tab.
  function openLiveTab(args: SshConnectArgs, name: string, sessionId?: string) {
    const connId = `live-${args.host}:${args.port}-${args.user}`
    const conn: Connection = {
      id: connId,
      group: '',
      kind: 'host',
      name,
      sub: `${args.user}@${args.host}:${args.port}`,
      icon: 'server',
      status: 'up',
      proto: 'ssh',
    }
    setLiveConns(prev => ({ ...prev, [connId]: conn }))
    if (sessionId) setSessionMap(prev => ({ ...prev, [connId]: sessionId }))
    const tabId = 'tab-' + connId
    setTabs(prev => prev.some(tb => tb.id === tabId)
      ? prev.map(tb => tb.id === tabId ? { ...tb, sessionId } : tb)
      : [...prev, { id: tabId, kind: 'terminal', connId, title: name, sessionId }])
    setActiveTab(tabId)
    setView('workbench')
    // Surface any newly-saved profile in the vault (saveProfile ran in the modal).
    reloadProfiles()
    // Record this as a recent session for the home screen. SSH vault entries are
    // keyed by the saved PROFILE id (not the live `live-…` connId), so resolve the
    // matching profile by host/port/user from the freshest store — this is what the
    // home resolves against, and it persists across restarts.
    const pid = loadProfiles().find(p => p.host === args.host && p.port === args.port && p.user === args.user)?.id
    if (pid) { recordRecentSession(pid); setRecentSessions(loadRecentSessions()) }

    // Detect the remote OS so the sidebar/home glyph shows the real OS logo. Runs
    // once per connect; persists onto the profile (survives restart) and updates the
    // live conn immediately. Best-effort — failures leave the generic host icon.
    if (sessionId) {
      void sshDetectOs(sessionId).then(os => {
        if (!os) return
        setLiveConns(prev => (prev[connId] ? { ...prev, [connId]: { ...prev[connId], os } } : prev))
        const prof = loadProfiles().find(p => p.host === args.host && p.port === args.port && p.user === args.user)
        if (prof && prof.os !== os) { try { saveProfile({ ...prof, os }); reloadProfiles() } catch { /* ignore */ } }
      }).catch(() => { /* best-effort */ })
    }

    // Subscribe to shell-command audit events for this session (Tauri only).
    // Reserve the slot SYNCHRONOUSLY before awaiting so a re-entrant call (e.g.
    // a second openLiveTab for the same session) can't double-subscribe.
    if (sessionId && !historyUnlisteners.current[sessionId]) {
      historyUnlisteners.current[sessionId] = () => { /* reserve immediately to block re-entry */ }
      void onHistory(sessionId, e => {
        // Per-event dedup: drop any event id we've already applied so one backend
        // command yields exactly one history row even with multiple listeners.
        if (seenHistIds.current.has(e.id)) return
        seenHistIds.current.add(e.id)
        // Bound the set so it can't grow without limit on long-lived sessions.
        if (seenHistIds.current.size > 5000) seenHistIds.current.clear()
        appendHistory({
          kind: 'shell',
          target: e.host || name,
          text: e.command,
          when: new Date().toLocaleTimeString(),
          dur: e.durationMs + 'ms',
          exitCode: e.exitCode ?? undefined,
          ts: Date.now() / 1000,
        })
        setHistory(loadHistory())
      }).then(unlisten => {
        // If the session was torn down while subscribing, unlisten now; otherwise
        // replace the placeholder with the real unlisten fn.
        if (historyUnlisteners.current[sessionId]) historyUnlisteners.current[sessionId] = unlisten
        else unlisten()
      })
    }
  }

  // ORCH connect entrypoint — invoked by NewConnectionModal's onConnect and by
  // reconnect actions. `args.secret` may carry an in-memory secret typed in the
  // modal; when present we connect straight away (no second prompt).
  async function connectProfile(args: SshConnectArgs, display: { name: string; profileId?: string }) {
    if (!isTauri()) {
      // Demo path: no IPC, just open a demo terminal tab (no sessionId).
      openLiveTab(args, display.name)
      return
    }
    // If the modal already supplied a target secret, the jump secret (if any) also
    // came from the form — connect directly (skip all prompts).
    if (args.secret && args.secret.length > 0) {
      void performConnect(args, display.name, args.secret, display.profileId)
      return
    }
    // Auth-gated cache: reuse a remembered secret (no prompt). Skipped when a jump
    // host still needs its own secret (we only cache the target secret).
    if (display.profileId && (!args.jump || args.jump.secret)) {
      const cached = await cachedSecret(display.profileId)
      if (cached) {
        void performConnect(args, display.name, cached, display.profileId)
        return
      }
    }
    // Reconnect path: collect secrets interactively.
    // If a jump host is configured AND it has no secret yet, collect jump secret first.
    if (args.jump && !args.jump.secret) {
      setPendingJumpSecret({ args, name: display.name, profileId: display.profileId })
      return
    }
    // Otherwise collect target secret.
    setPendingConnect({ args, name: display.name, profileId: display.profileId })
  }

  // Secret collected → call sshConnect; route to trust prompt / success / error.
  // args.jump (with its secret) is forwarded intact to sshConnect.
  async function performConnect(args: SshConnectArgs, name: string, secret: string, profileId?: string) {
    // Immediate feedback: show the connecting overlay before the (1–2s) await.
    setConnecting(name)
    try {
      const result = await sshConnect({ ...args, secret, jump: args.jump })
      // Auth succeeded → the secret is valid; cache it (when auth + vault allow).
      if (profileId) rememberConnSecret(profileId, secret)
      if (result.hostKeyTrusted === false) {
        setPendingTrust({ args, name, sessionId: result.sessionId, fingerprint: result.hostKeyFingerprint })
        return
      }
      openLiveTab(args, name, result.sessionId)
    } catch (err) {
      const kind = (err as { kind?: string } | null)?.kind
      if (kind === 'HostKeyMismatch') {
        setConnectError(t('modals.connectErrorMismatch'))
      } else {
        const raw = (err as { message?: string } | null)?.message ?? String(err)
        // Humanise the common auth failure; otherwise surface the raw reason.
        const message = /auth/i.test(raw) ? t('modals.connectErrorAuth') : t('modals.connectErrorGeneric', { message: raw })
        setConnectError(message)
      }
    } finally {
      setConnecting(null)
    }
  }

  // Trust accepted → record host key, then open the (already-established) session.
  async function trustAndOpen(p: NonNullable<typeof pendingTrust>) {
    try {
      await sshTrustHost(`${p.args.host}:${p.args.port}`, p.fingerprint)
    } catch { /* best-effort — proceed even if recording fails */ }
    openLiveTab(p.args, p.name, p.sessionId)
    setPendingTrust(null)
  }

  // Trust rejected → tear down the untrusted session.
  function rejectTrust(p: NonNullable<typeof pendingTrust>) {
    sshDisconnect(p.sessionId).catch(() => { /* best-effort */ })
    setPendingTrust(null)
  }

  async function openConn(conn: Connection) {
    // Record this as a recent session (newest-first) for the home screen.
    recordRecentSession(conn.id)
    setRecentSessions(loadRecentSessions())
    // If this vault entry maps to a saved profile, run the REAL connect flow
    // (collects the secret, verifies host key, opens a live session/tab).
    const profile = profiles.find(p => p.id === conn.id)
    if (profile) {
      void connectProfile(
        { host: profile.host, port: profile.port, user: profile.user, auth: profile.auth, jump: profile.jump },
        { name: profile.name, profileId: profile.id },
      )
      return
    }
    // DB connection: if already live, open its SQL workbench tab; otherwise reuse a
    // cached secret (auth-gated) or prompt for the password and connect. Falls back
    // to the details panel only if the saved profile can't be resolved.
    if (conn.kind === 'db') {
      const active = listActiveDbConnections().find(a => a.profileId === conn.id)
      if (active) {
        const tabId = 'tab-' + conn.id
        setTabs(prev => prev.some(tb => tb.id === tabId) ? prev : [...prev, {
          id: tabId, kind: 'sql', connId: conn.id, title: conn.name,
        }])
        setActiveTab(tabId)
        setView('workbench')
      } else {
        const dbp = dbProfiles.find(p => p.id === conn.id)
        if (dbp) {
          const cached = await cachedSecret(dbp.id)
          if (cached) {
            try { await connectDbProfile(dbp, cached); return } catch { /* fall through to prompt */ }
          }
          setDbPromptError(null); setPendingDbConnect(dbp)
        } else openDetail(conn)
      }
      return
    }
    // Fallback: live display host conns without a saved profile just open a tab.
    const tabId = 'tab-' + conn.id
    setTabs(prev => prev.some(tb => tb.id === tabId) ? prev : [...prev, {
      id: tabId,
      kind: 'terminal',
      connId: conn.id,
      title: conn.name,
    }])
    setActiveTab(tabId)
    setView('workbench')
  }
  // If a closing tab held a live session that no remaining tab shares, drop it.
  function reapSession(closing: Tab | undefined, remaining: Tab[]) {
    // Abort any in-flight agent stream + drop this tab's current-conversation map.
    if (closing) {
      agentAborts.current[closing.id]?.abort()
      delete agentAborts.current[closing.id]
      setCurrentConvByTab(prev => {
        if (!(closing.id in prev)) return prev
        const n = { ...prev }
        delete n[closing.id]
        return n
      })
      // DB tab: when no remaining tab uses this connection, release its live
      // backend connection. This keeps "has an open tab" ⟺ "active connection",
      // so the details panel correctly offers 连接 (not 关闭连接) once the tab is
      // gone. (disconnectDbProfile already clears actives before closeTab, so this
      // is a no-op there — it only fires when the tab is closed via its ✕.)
      const stillOpen = remaining.some(tb => tb.connId === closing.connId)
      if (!stillOpen) {
        const actives = listActiveDbConnections().filter(a => a.profileId === closing.connId)
        if (actives.length > 0) {
          actives.forEach(a => {
            dbDisconnect(a.connId).catch(() => { /* best-effort */ })
            removeActiveDbConnection(a.connId)
          })
          bumpDbActive()
          syncMcpTargets()
        }
      }
    }
    if (!closing?.sessionId) return
    const sid = closing.sessionId
    const stillUsed = remaining.some(tb => tb.sessionId === sid)
    if (stillUsed) return
    sshDisconnect(sid).catch(() => { /* best-effort */ })
    // Unsubscribe from history audit events for this session.
    const unlisten = historyUnlisteners.current[sid]
    if (unlisten) {
      unlisten()
      delete historyUnlisteners.current[sid]
    }
    setSessionMap(prev => {
      const next = { ...prev }
      delete next[closing.connId]
      return next
    })
    setLiveConns(prev => {
      const next = { ...prev }
      delete next[closing.connId]
      return next
    })
    setChanMap(prev => {
      const next = { ...prev }
      delete next[sid]
      return next
    })
  }
  function closeTab(id: string) {
    setTabs(prev => {
      const closing = prev.find(tb => tb.id === id)
      const next = prev.filter(tb => tb.id !== id)
      reapSession(closing, next)
      if (next.length === 0) {
        setView('home') // no sessions left → back to home automatically
      } else if (activeTab === id) {
        setActiveTab(next[next.length - 1].id)
      }
      return next
    })
  }
  function closeOthers(id: string) {
    setTabs(prev => {
      const next = prev.filter(tb => tb.id === id)
      prev.filter(tb => tb.id !== id).forEach(tb => reapSession(tb, next))
      if (next.length === 0) {
        setView('home')
      } else {
        setActiveTab(id)
      }
      return next
    })
  }
  function closeAll() {
    setTabs(prev => {
      prev.forEach(tb => reapSession(tb, []))
      return []
    })
    setView('home')
  }
  function openDetail(conn: Connection) {
    // If this connection already has an open tab, activate it so the focused
    // sidebar card and the middle workbench tab stay consistent (clicking a host
    // surfaces its terminal, a DB its workbench — not whatever tab was active).
    const tab = tabs.find(tb => tb.connId === conn.id)
    if (tab) {
      setActiveTab(tab.id)
      setView('workbench')
    }
    setDetailConn(conn)
    setActivePanel('details')
    setPanelOpen(true)
  }
  // Hide the connection-details panel (used after a successful connect).
  function closeDetailPanel() {
    setPanelOpen(false)
    setDetailConn(null)
  }

  // ---- DB details-panel actions (operate on the saved DbProfile) ----
  function editDbProfile(profile: DbProfile) {
    // Open the New Connection modal in EDIT mode pre-filled with this profile.
    setEditProfile(profile)
    setShowNew(true)
  }
  function deleteDbProfile(profile: DbProfile) {
    // Drop any active live connection for this profile, then remove the profile.
    listActiveDbConnections()
      .filter(a => a.profileId === profile.id)
      .forEach(a => removeActiveDbConnection(a.connId))
    removeDbConnection(profile.id)
    syncMcpTargets()
    // The reactive store updates the list; close the details panel.
    setPanelOpen(false)
    setDetailConn(null)
  }
  async function connectDbProfile(profile: DbProfile, secret: string) {
    // If a live connection already exists for this profile, open the workbench directly.
    const existing = listActiveDbConnections().find(a => a.profileId === profile.id)
    if (existing) {
      openConn(dbProfileToConnection(profile, true))
      setView('workbench')
      closeDetailPanel()
      return
    }
    // Real connect (Tauri). Throws outside Tauri / on failure — DetailsPanel surfaces it.
    // IMPORTANT: thread driverProfile + options (advanced params) — without them a
    // reconnect loses e.g. MongoDB's directConnection/authSource and hangs on
    // replica-set discovery, or a protocol-family variant connects as the base.
    const result = await dbConnect({
      dbType: profile.dbType,
      ...(profile.driverProfile ? { driverProfile: profile.driverProfile } : {}),
      ...(profile.options ? { options: profile.options } : {}),
      host: profile.host,
      port: profile.port,
      user: profile.user,
      ...(profile.database ? { database: profile.database } : {}),
      secret: secret || undefined,
    })
    setActiveDbConnection(result, profile)
    // Auth succeeded → cache the secret (when auth + vault allow).
    rememberConnSecret(profile.id, secret)
    bumpDbActive()
    syncMcpTargets()
    void openConn(dbProfileToConnection(profile, true))
    setView('workbench')
    // Success → auto-hide the connection details panel.
    closeDetailPanel()
  }

  // DetailsPanel "连接": try a cached secret first. Returns true if it connected,
  // false if there's no cached secret (→ panel prompts for the password). A real
  // connect failure (auth/timeout) is RE-THROWN so the panel can surface why,
  // instead of silently popping a password prompt with no explanation.
  async function tryConnectDbCached(profile: DbProfile): Promise<boolean> {
    const cached = await cachedSecret(profile.id)
    if (!cached) return false
    await connectDbProfile(profile, cached)
    return true
  }

  // Disconnect every live connection for a DB profile (details panel "关闭连接").
  async function disconnectDbProfile(profile: DbProfile) {
    const actives = listActiveDbConnections().filter(a => a.profileId === profile.id)
    for (const a of actives) {
      try { await dbDisconnect(a.connId) } catch { /* best-effort */ }
      removeActiveDbConnection(a.connId)
    }
    closeTab('tab-' + profile.id)
    bumpDbActive()
    syncMcpTargets()
    // Reflect the new (disconnected) status in the open details panel.
    setDetailConn(prev => (prev && prev.id === profile.id ? { ...prev, status: 'idle' } : prev))
  }

  // Submit handler for the direct DB connect prompt (opened from a DB card).
  // Shows the shared connecting overlay, surfaces a friendly inline error on
  // failure (keeps the prompt open for retry), and closes on success.
  async function submitDbConnect(secret: string) {
    const profile = pendingDbConnect
    if (!profile || dbPromptBusy) return
    setDbPromptBusy(true)
    setDbPromptError(null)
    setConnecting(profile.name)
    try {
      await connectDbProfile(profile, secret)
      setPendingDbConnect(null)
    } catch (err) {
      const msg = dbErrMsg(err)
      // Non-Tauri dev has no DB backend — just close quietly (matches the modal).
      if (msg.includes('Tauri runtime')) { setPendingDbConnect(null); return }
      setDbPromptError(/auth|password/i.test(msg) ? t('modals.connectErrorAuth') : msg)
    } finally {
      setDbPromptBusy(false)
      setConnecting(null)
    }
  }

  // ---- SSH DetailsPanel actions (operate on the REAL saved SSH profile) ----

  // 连接 — look up the profile and run the real connect flow.
  function connectFromDetail(conn: Connection) {
    const profile = profiles.find(p => p.id === conn.id)
    if (!profile) return
    void connectProfile(
      { host: profile.host, port: profile.port, user: profile.user, auth: profile.auth, jump: profile.jump },
      { name: profile.name, profileId: profile.id },
    )
    // Auto-hide the details panel once the connect is initiated.
    closeDetailPanel()
  }

  // 编辑 — open NewConnectionModal in EDIT mode prefilled from the profile.
  function editConn(conn: Connection) {
    const profile = profiles.find(p => p.id === conn.id)
    if (!profile) return
    setEditing(profile)
  }

  // 复制 — duplicate the profile under a fresh, unique id.
  function copyConn(conn: Connection) {
    const profile = profiles.find(p => p.id === conn.id)
    if (!profile) return
    const existing = new Set(profiles.map(p => p.id))
    let newId = `${profile.id}-copy`
    let n = 2
    while (existing.has(newId)) { newId = `${profile.id}-copy${n}`; n += 1 }
    try {
      saveProfile({ ...profile, id: newId, name: `${profile.name} (副本)` })
    } catch { /* localStorage unavailable — ignore */ }
    reloadProfiles()
  }

  // Import hosts from the local ~/.ssh/config into the vault (idempotent by alias).
  // Returns counts so the Settings UI can report the result.
  async function importHostsFromSshConfig(): Promise<{ added: number; total: number }> {
    const hosts = await importSshConfig()
    const existingIds = new Set(loadProfiles().map(p => p.id))
    let added = 0
    for (const h of hosts) {
      const id = `ssh-config-${h.alias}`
      if (existingIds.has(id)) continue
      const auth: AuthMethod = h.identityFile ? { method: 'keyFile', path: h.identityFile } : { method: 'password' }
      const jump = h.jump
        ? {
            host: h.jump.host, port: h.jump.port, user: h.jump.user,
            auth: (h.jump.identityFile ? { method: 'keyFile', path: h.jump.identityFile } : { method: 'password' }) as AuthMethod,
          }
        : undefined
      saveProfile({ id, name: h.alias, host: h.host, port: h.port, user: h.user, auth, ...(jump ? { jump } : {}) })
      existingIds.add(id)
      added += 1
    }
    if (added > 0) reloadProfiles()
    return { added, total: hosts.length }
  }

  // Tear down a live session for a connId (disconnect + drop maps + close its tab).
  function teardownSession(connId: string) {
    const sid = sessionMap[connId]
    if (sid) sshDisconnect(sid).catch(() => { /* best-effort */ })
    setSessionMap(prev => { const next = { ...prev }; delete next[connId]; return next })
    setLiveConns(prev => { const next = { ...prev }; delete next[connId]; return next })
    if (sid) setChanMap(prev => { const next = { ...prev }; delete next[sid]; return next })
    closeTab('tab-' + connId)
  }

  // 关闭会话 — disconnect the live session for this connection.
  function closeSessionForConn(conn: Connection) {
    teardownSession(conn.id)
    setDetailConn(prev => prev && prev.id === conn.id ? { ...prev, status: 'idle' } : prev)
  }

  // 删除 (confirmed) — remove the profile, tear down any session, close the panel.
  function confirmDelete(conn: Connection) {
    if (sessionMap[conn.id]) teardownSession(conn.id)
    try { deleteProfile(conn.id) } catch { /* localStorage unavailable — ignore */ }
    reloadProfiles()
    if (detailConn?.id === conn.id) { setDetailConn(null); setPanelOpen(false) }
  }
  function selectPanel(id: string) {
    if (activePanel === id && panelOpen) { setPanelOpen(false) }
    else { setActivePanel(id); setPanelOpen(true) }
  }
  // Open Settings, optionally to a specific section (e.g. 'security', 'ai'). The
  // guard handles being used directly as a click handler (event arg != string).
  function goSettings(section?: string) {
    setSettingsSection(typeof section === 'string' ? section : 'appearance')
    if (view !== 'settings') setPrevView(view)
    setView(view === 'settings' ? prevView : 'settings')
  }

  const cur = tabs.find(tb => tb.id === activeTab)
  // Resolve the active tab's connection: prefer the live vault list (real saved DB
  // connections + saved SSH host profiles), then live SSH display conns, then the
  // mock byId index. This lets a workbench tab opened for a real saved DB profile
  // OR a live SSH session resolve to its Connection.
  const curConn = cur ? (vaultConns.find(c => c.id === cur.connId) ?? liveConns[cur.connId] ?? D.byId[cur.connId] ?? null) : null
  const aiMode = cur && cur.kind === 'terminal' ? 'shell' : 'sql'

  // Write text into the active terminal's live PTY channel (no trailing newline).
  async function insertToTerminal(code: string) {
    const sid = cur?.sessionId
    const chan = sid ? chanMap[sid] : undefined
    if (!sid || !chan) return
    const { termWrite } = await import('./services/ssh')
    await termWrite(sid, chan, btoa(unescape(encodeURIComponent(code))))
  }
  const canInsert = !!(cur?.sessionId && chanMap[cur.sessionId])
  // Whether the focused tab is an active DB workbench — gates the SQL editor
  // insert affordance (mirrors `canInsert` for terminals). A DB tab has kind
  // 'sql'; the SqlConsole catio-insert listener lands the text in its active
  // query editor.
  const canInsertEditor = view === 'workbench' && cur?.kind === 'sql'

  // ---- Agent conversation controller (P2) ----

  // Resolve the conversation id for a tab, lazily creating + persisting a fresh
  // one for the tab's host (connId) if none is mapped yet. Returns the id.
  function ensureConvId(tab: Tab): string {
    const existing = currentConvByTab[tab.id]
    if (existing) return existing
    const conv = makeConversation(tab.connId)
    upsertConversation(conv)
    setCurrentConvByTab(prev => ({ ...prev, [tab.id]: conv.id }))
    return conv.id
  }

  // Mutate a conversation by id in the ref (source of truth) + localStorage +
  // render state. Persistence reads from the freshly-computed value, never from
  // a setState updater return (which is unreliable under streaming bursts).
  function patchConversation(convId: string, fn: (c: Conversation) => Conversation) {
    let updated: Conversation | undefined
    const next = conversationsRef.current.map(c => {
      if (c.id !== convId) return c
      updated = fn(c)
      return updated
    })
    if (!updated) return
    conversationsRef.current = next
    setConversations(next)
    saveConversation(updated)
  }

  // Fetch sysinfo for a session once and cache it; subsequent calls return the
  // cached string immediately. If the fetch fails, '' is cached so we don't retry
  // on every message (the LLM just won't have that context for this session).
  async function getSysinfo(sessionId: string): Promise<string> {
    if (sessionId in sysinfoCache.current) {
      return sysinfoCache.current[sessionId]
    }
    try {
      const info = await sshSysinfo(sessionId)
      sysinfoCache.current[sessionId] = info
      return info
    } catch {
      sysinfoCache.current[sessionId] = ''
      return ''
    }
  }

  async function sendAgentMessage(tabId: string, text: string) {
    const tab = tabs.find(tb => tb.id === tabId)
    if (!tab) return
    const convId = ensureConvId(tab)
    const tabConn = D.byId[tab.connId] ?? liveConns[tab.connId] ?? null
    const hostName = tabConn?.name ?? tab.title

    // Snapshot the prior messages for the outgoing payload BEFORE appending.
    const prior = conversationsRef.current.find(c => c.id === convId)?.messages ?? []

    // Append the user message + an empty assistant placeholder; persist.
    patchConversation(convId, c => ({
      ...c,
      messages: [...c.messages, { role: 'user', content: text }, { role: 'assistant', content: '' }],
    }))

    // ---- P3 SEAM: enrich the system prompt with host sysinfo (OS/time/CPU/mem/disk/GPU).
    // Fetch once per session (cached); await before building outgoing payload so the
    // system message is complete. If the tab has no live session or fetch fails, the
    // prompt falls back to the base shell-assistant instruction unchanged.
    const liveSessionId = tab.sessionId
    const sysinfo = liveSessionId ? await getSysinfo(liveSessionId) : ''
    const sysinfoBlock = sysinfo
      ? `\n\n系统会话上下文（当前连接的主机信息，供参考）:\n${sysinfo}\n回答时可据此结合该主机的实际环境（操作系统/时间/CPU/内存/磁盘/GPU）。`
      : ''
    // ---- Read terminal buffer (opt-in pref): feed the agent the active
    // terminal's most recent output so it can reason about what just happened.
    const termTail = prefs.termBufferEnabled && liveSessionId
      ? readTermBufferTail(liveSessionId, prefs.termBufferLines)
      : ''
    const termBlock = termTail
      ? `\n\n当前终端最近输出（最多 ${prefs.termBufferLines} 行，供参考）:\n\`\`\`\n${termTail}\n\`\`\``
      : ''
    const system: ChatMsg = {
      role: 'system',
      content: `You are a terminal/shell assistant for host "${hostName}". When you suggest a shell command, put it in a fenced code block.${sysinfoBlock}${termBlock}`,
    }
    const outgoing: ChatMsg[] = [
      system,
      ...prior.map(m => ({ role: m.role, content: m.content } as ChatMsg)),
      { role: 'user', content: text },
    ]

    const controller = new AbortController()
    agentAborts.current[tabId] = controller
    setBusyConvs(prev => ({ ...prev, [convId]: true }))
    try {
      await chat(outgoing, agentCfg, {
        signal: controller.signal,
        onToken: tok => patchConversation(convId, c => {
          const msgs = [...c.messages]
          const last = msgs.length - 1
          if (last >= 0 && msgs[last].role === 'assistant') {
            msgs[last] = { ...msgs[last], content: msgs[last].content + tok }
          }
          return { ...c, messages: msgs }
        }),
      })
    } catch (err) {
      if (controller.signal.aborted) return
      const message = (err as { message?: string } | null)?.message ?? String(err)
      patchConversation(convId, c => {
        const msgs = [...c.messages]
        const last = msgs.length - 1
        if (last >= 0 && msgs[last].role === 'assistant') {
          msgs[last] = { ...msgs[last], content: t('panels.agentError', { message }) }
        }
        return { ...c, messages: msgs }
      })
    } finally {
      delete agentAborts.current[tabId]
      setBusyConvs(prev => { const n = { ...prev }; delete n[convId]; return n })
    }
  }

  function newAgentConversation(tabId: string) {
    const tab = tabs.find(tb => tb.id === tabId)
    if (!tab) return
    const conv = makeConversation(tab.connId)
    upsertConversation(conv)
    setCurrentConvByTab(prev => ({ ...prev, [tabId]: conv.id }))
  }

  function restoreConversation(tabId: string, convId: string) {
    setCurrentConvByTab(prev => ({ ...prev, [tabId]: convId }))
  }

  function deleteAgentConversation(tabId: string, convId: string) {
    deleteConversationStore(convId)
    const next = conversationsRef.current.filter(c => c.id !== convId)
    conversationsRef.current = next
    setConversations(next)
    // If the deleted conv was current for this tab, drop the mapping so a fresh
    // one is created lazily on next render/send.
    setCurrentConvByTab(prev => {
      if (prev[tabId] !== convId) return prev
      const n = { ...prev }
      delete n[tabId]
      return n
    })
  }

  // The conversation object shown for the ACTIVE tab (created lazily on render so
  // the panel always has something to render for the active tab's host).
  const activeConvId = cur ? currentConvByTab[cur.id] : undefined
  const activeConversation = activeConvId ? conversations.find(c => c.id === activeConvId) : undefined
  const activeConvBusy = activeConvId ? !!busyConvs[activeConvId] : false
  const agentHistory = cur ? conversationsForHost(cur.connId) : []

  // Lazily create a conversation for the active tab so the panel has one to show.
  useEffect(() => {
    if (cur && !currentConvByTab[cur.id]) {
      ensureConvId(cur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id])

  return (
    <div className="win">
      <TitleBar theme={theme_} onToggleTheme={() => setThemeBoth(nextTheme(theme_))}
        onOpenSettings={() => goSettings()} settingsActive={view === 'settings'} onSearch={() => {}} />

      {/* content region — body is ALWAYS mounted so terminals/workbench survive
          view switches; Settings renders as an overlay on top (does NOT unmount
          the body), mirroring the AuthGate overlay pattern. */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex' }}>
        <div className="body" style={{ flex: 1 }}>
          <Sidebar activeId={detailConn ? detailConn.id : (cur ? cur.connId : undefined)} onOpen={openDetail} onDetail={openDetail}
            collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(c => !c)}
            conns={vaultConns} currentUser={currentName} authEnabled={authEnabled} onLock={lockApp} onEnableAuth={() => goSettings('security')}
            filter={sidebarFilter} onFilterChange={setSidebarFilter} />

          {/* main */}
          <div className="card-surface grow col" style={{ overflow: 'hidden', position: 'relative' }}>
            {/* view body */}
            <div className="grow col" style={{ minHeight: 0 }}>
              {view === 'home' && <HomeView onOpen={openConn} onNew={() => setShowNew(true)} owned={ownsVault} userName={authEnabled ? currentName : ''} authEnabled={authEnabled} conns={vaultConns}
                recent={recentSessions.map(r => vaultConns.find(c => c.id === r.connId)).filter((c): c is Connection => !!c)} />}

              {/* tab bar — only in workbench when there are tabs */}
              {view === 'workbench' && tabs.length > 0 && (
                <WorkbenchTabs tabs={tabs} activeTab={activeTab} onActivate={setActiveTab} onClose={closeTab} onCloseOthers={closeOthers} onCloseAll={closeAll} onNew={() => setShowNew(true)} />
              )}
              {view === 'workbench' && tabs.length === 0 && <EmptyWorkbench onNew={() => setShowNew(true)} />}

              {/* persistent panes container — ALWAYS mounted regardless of view.
                  One pane per tab; visibility toggled via CSS display so the live
                  PTY + xterm buffer survive home/settings/tab switches. A pane is
                  shown only when this is the active workbench tab; otherwise it is
                  display:none but stays mounted. term_close fires only when a tab
                  is removed from `tabs` (real close) → React unmounts that pane. */}
              {tabs.length > 0 && (
                <div className="grow" style={{ minHeight: 0, position: 'relative', display: view === 'workbench' ? 'block' : 'none' }}>
                  {tabs.map(tab => {
                    // Resolve the tab's display connection. liveConns first (live SSH
                    // status), then the real saved vault connections (incl. DB — without
                    // this a DB SQL tab gets a null conn and renders blank), then mock.
                    const tabConn = liveConns[tab.connId] ?? vaultConns.find(c => c.id === tab.connId) ?? D.byId[tab.connId] ?? null
                    const isShown = view === 'workbench' && tab.id === activeTab
                    return (
                      <div key={tab.id} style={{ height: '100%', display: isShown ? 'flex' : 'none', position: 'absolute', inset: 0 }}>
                        {tab.kind === 'terminal' && (
                          <TerminalPane conn={tabConn} sessionId={tab.sessionId} active={isShown} resolveSessionId={resolveSessionId} onChannel={(sid, chan) => setChanMap(m => { const n = { ...m }; if (chan) n[sid] = chan; else delete n[sid]; return n })} />
                        )}
                        {tab.kind === 'sql' && tabConn && (
                          <DbWorkbench conn={tabConn} density={density} active={isShown} />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* AI floating / bar forms render inside main */}
            {aiForm === 'floating' && <AIFloating mode={aiMode} conn={curConn} />}
            {aiForm === 'bar' && <AICommandBar mode={aiMode} conn={curConn} />}
          </div>

          {/* panel slot */}
          {panelOpen && (aiForm === 'side' || activePanel !== 'ai') && (
            <div className="fade-in" style={{ display: 'flex' }}>
              {activePanel === 'ai' && <AIPanel onClose={() => setPanelOpen(false)} mode={aiMode} conn={curConn ?? undefined} connId={cur?.connId} engine={curConn?.engine} attachment={aiAttachment} onClearAttachment={() => setAiAttachment(null)} onInsert={insertToTerminal} canInsert={canInsert} onOpenSettings={() => goSettings('ai')}
                conversation={activeConversation} busy={activeConvBusy} history={agentHistory}
                onSend={cur ? (text => void sendAgentMessage(cur.id, text)) : undefined}
                onAbort={cur ? (() => agentAborts.current[cur.id]?.abort()) : undefined}
                onNewConversation={cur ? (() => newAgentConversation(cur.id)) : undefined}
                onRestoreConversation={cur ? (convId => restoreConversation(cur.id, convId)) : undefined}
                onDeleteConversation={cur ? (convId => deleteAgentConversation(cur.id, convId)) : undefined} />}
              {activePanel === 'sftp' && <SftpPanel onClose={() => setPanelOpen(false)} conn={curConn ?? undefined} sessionId={cur?.sessionId} />}
              {activePanel === 'monitor' && <MonitorPanel onClose={() => setPanelOpen(false)} sessionId={cur?.sessionId} />}
              {activePanel === 'tunnels' && <TunnelsPanel onClose={() => setPanelOpen(false)} sessionId={cur?.sessionId} activeConnId={cur?.connId} profiles={profiles} />}
              {activePanel === 'snippets' && <SnippetsPanel onClose={() => setPanelOpen(false)} snippets={snippets} onChange={() => setSnippets(loadSnippets())} onInsert={insertToTerminal} canInsert={canInsert} canInsertEditor={canInsertEditor} />}
              {activePanel === 'history' && <HistoryPanel onClose={() => setPanelOpen(false)} onAddSnippet={addSnippet} items={mergedHistory} onClear={() => { clearHistory(); setHistory([]); setDbHistory([]); void clearDbHistory() }}
                onDelete={h => {
                  // Route the delete to the right store by kind: SQL queries live in
                  // the backend history file; shell commands live in localStorage.
                  if (h.kind === 'sql') { setDbHistory(prev => prev.filter(x => x.id !== h.id)); void deleteDbHistory(h.id) }
                  else { deleteHistory(h.id); setHistory(loadHistory()) }
                }}
                onInsert={insertToTerminal} canInsert={canInsert} canInsertEditor={canInsertEditor} />}
              {/* DetailsPanel branches internally on conn.kind === 'db': DB conns use the
                  onEditDb/onDeleteDb/onConnectDb handlers; host conns use the SSH handlers. */}
              {activePanel === 'details' && (
                <DetailsPanel
                  conn={detailConn ?? undefined}
                  connected={detailConn ? !!sessionMap[detailConn.id] : false}
                  onClose={() => setPanelOpen(false)}
                  // DB-specific actions (operate on the saved DbProfile)
                  onEditDb={editDbProfile}
                  onDeleteDb={deleteDbProfile}
                  onConnectDb={connectDbProfile}
                  onDisconnectDb={disconnectDbProfile}
                  onTryConnectDb={tryConnectDbCached}
                  // Host / SSH actions (operate on the Connection)
                  onConnect={connectFromDetail}
                  onEdit={editConn}
                  onCopy={copyConn}
                  onDelete={conn => setPendingDelete(conn)}
                  onCloseSession={closeSessionForConn}
                />
              )}
            </div>
          )}

          {/* icon rail */}
          <IconRail active={activePanel} onSelect={selectPanel} panelOpen={panelOpen} />
        </div>

        {/* Settings overlay — covers the body region (below the title bar) without
            unmounting it. SettingsView keeps its identical markup/props/behavior. */}
        {view === 'settings' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', background: 'var(--bg-canvas)' }}>
            <SettingsView theme={theme_} onTheme={setThemeBoth} onClose={() => setView(prevView)} initialSection={settingsSection}
              onImportSshConfig={importHostsFromSshConfig}
              authEnabled={authEnabled} users={users} currentUser={currentName} ownerUser={ownerUser}
              onEnableAuth={enableAuth} onDisableAuth={disableAuth} onLock={lockApp} onRemoveUser={(name: string) => {
                const next = users.filter(x => x.username !== name)
                setUsers(next)
                localStorage.setItem('catio-users', JSON.stringify(next))
              }} />
          </div>
        )}
      </div>

      {/* Unified New/Edit connection modal — supports BOTH host/SSH and DB kinds.
          `editing` (ConnectionProfile) drives SSH edit mode; `editProfile`
          (DbProfile) drives DB edit mode; otherwise it's a create flow whose
          default kind comes from the sidebar filter. */}
      {(showNew || editing || editProfile) && (
        <NewConnectionModal
          key={editing ? editing.id : editProfile ? editProfile.id : 'new'}
          editProfile={editing ?? editProfile ?? undefined}
          initialKind={sidebarFilter === 'host' ? 'host' : sidebarFilter === 'db' ? 'db' : undefined}
          onSaved={reloadProfiles}
          onClose={() => { setShowNew(false); setEditing(null); setEditProfile(null) }}
          onConnect={connectProfile}
          onConnected={(profile, secret) => {
            if (secret) rememberConnSecret(profile.id, secret)
            bumpDbActive()
            syncMcpTargets()
            void openConn(dbProfileToConnection(profile, true))
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title={t('modals.deleteConfirmTitle')}
          message={t('modals.deleteConfirmMsg', { name: pendingDelete.name })}
          confirmLabel={t('modals.confirmDelete')}
          danger
          onConfirm={() => { const c = pendingDelete; setPendingDelete(null); confirmDelete(c) }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingJumpSecret && (
        <ConnectSecretPrompt
          label={t('panels.jumpSecretPrompt', { host: pendingJumpSecret.args.jump?.host ?? '' })}
          onSubmit={jumpSec => {
            const p = pendingJumpSecret
            setPendingJumpSecret(null)
            // Attach the jump secret (in-memory only) then collect target secret.
            const argsWithJump: SshConnectArgs = {
              ...p.args,
              jump: p.args.jump ? { ...p.args.jump, secret: jumpSec } : undefined,
            }
            setPendingConnect({ args: argsWithJump, name: p.name, profileId: p.profileId })
          }}
          onCancel={() => setPendingJumpSecret(null)}
        />
      )}

      {pendingConnect && (
        <ConnectSecretPrompt
          label={pendingConnect.args.auth.method === 'keyFile' ? t('modals.secretPromptPassphrase') : t('modals.secretPromptPassword')}
          onSubmit={secret => {
            const p = pendingConnect
            setPendingConnect(null)
            void performConnect(p.args, p.name, secret, p.profileId)
          }}
          onCancel={() => setPendingConnect(null)}
        />
      )}

      {pendingDbConnect && (
        <ConnectSecretPrompt
          title={t('panels.connectPromptTitle', { name: pendingDbConnect.name })}
          label={t('panels.connectPromptLabel')}
          error={dbPromptError}
          onSubmit={s => { void submitDbConnect(s) }}
          onCancel={() => { if (!dbPromptBusy) { setPendingDbConnect(null); setDbPromptError(null) } }}
        />
      )}

      {pendingTrust && (
        <HostKeyPrompt
          host={`${pendingTrust.args.host}:${pendingTrust.args.port}`}
          fingerprint={pendingTrust.fingerprint}
          onTrust={() => { void trustAndOpen(pendingTrust) }}
          onCancel={() => rejectTrust(pendingTrust)}
        />
      )}

      {/* Connecting overlay — immediate feedback during the SSH handshake. */}
      {connecting && <ConnectingOverlay name={connecting} />}

      {/* Connect error — styled in-app dialog (replaces native window.alert). */}
      {connectError && (
        <AlertModal title={t('modals.connectFailedTitle')} message={connectError} onClose={() => setConnectError(null)} />
      )}

      {locked && <AuthGate users={users} onLogin={loginUser} onCreate={createUser} onCancel={disableAuth} />}
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
          <Icon name="wand" size={18} /> {isSql ? t('app.sqlAssistant') : t('app.shellAssistant')}
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
        <Icon name="wand" size={17} style={{ color: 'var(--accent-primary)' }} />
        <input value={v} onChange={e => setV(e.target.value)}
          placeholder={isSql ? t('app.cmdBarSqlPlaceholder', { target }) : t('app.cmdBarShellPlaceholder', { target })}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, color: 'var(--text-primary)' }} />
        <span className="chip" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone, fontWeight: 600 }}><Icon name={isSql ? 'database' : 'terminal'} size={11} /> {isSql ? 'SQL' : 'Shell'} · {target}</span>
        <button className="btn btn-primary sm" style={{ width: 32, padding: 0 }}><Icon name="send" size={14} /></button>
      </div>
    </div>
  )
}
