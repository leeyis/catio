/* ported from ref-ui/_extract/blob15.txt — verbatim per plan T1-T7 */
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TitleBar, Sidebar, IconRail } from './components/shell/Sidebar'
import { HomeView } from './components/views/HomeView'
import ScanWizard from './components/scan/ScanWizard'
import { SettingsView } from './components/views/SettingsView'
import { WorkbenchTabs } from './components/workbench/WorkbenchTabs'
import { RemoteFileEditor } from './components/workbench/RemoteFileEditor'
import { LocalTerminalPane } from './components/workbench/LocalTerminalPane'
import { SplitTerminal } from './components/workbench/SplitTerminal'
import { VncPane } from './components/workbench/VncPane'
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
import { buildAgentSystemPrompt } from './services/agentPrompt'
import { useData } from './state/DataContext'
import { dbConnect, dbConnectArgsFromProfile, dbDisconnect, getHistory as getDbHistory, clearDbHistory, deleteDbHistory, deleteDbHistoryForProfile, dbErrMsg } from './services/db'
import {
  useDbConnections, useActiveDbConnections, dbProfileToConnection, listActiveDbConnections,
  setActiveDbConnection, removeDbConnection, removeActiveDbConnection, saveDbConnection,
  type DbProfile,
} from './state/dbConnections'
import { sshConnect, sshDisconnect, sshTrustHost, isTauri, onHistory, sshSysinfo, sshDetectOs, importSshConfig, tunnelOpen, rdpLaunch } from './services/ssh'
import { isServer } from './services/transport'
import { useServerAuth } from './components/auth/ServerAuthGate'
import { secretRecall, secretRemember } from './services/secrets'
import { useTunnelConnections, saveTunnelConnection, removeTunnelConnection, generateTunnelId } from './state/tunnelConnections'
import { useRdpConnections, saveRdpConnection, removeRdpConnection, generateRdpId } from './state/rdpConnections'
import { useVncConnections, saveVncConnection, removeVncConnection, generateVncId } from './state/vncConnections'
import { setSessionSecret } from './state/sessionSecrets'
import type { SshConnectArgs, AuthMethod } from './services/ssh'
import { mcpSyncTargets } from './services/mcp'
import { createVaultCredential, unlockVault, lockVault, isVaultUnlocked, recallSecret, rememberSecret } from './state/vault'
import { appendHistory, loadHistory, clearHistory, deleteHistory, deleteHistoryForProfile } from './state/history'
import { loadRecentSessions, recordRecentSession } from './state/recentSessions'
import { getSessionSecret } from './state/sessionSecrets'
import type { HistoryItem } from './services/types'
import { loadProfiles, saveProfile, deleteProfile } from './state/connections'
import { saveOpenTabs, restoreOpenTabs } from './state/tabPersistence'
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
  const serverAuth = useServerAuth()
  const dbProfiles = useDbConnections()
  // 订阅活跃 DB 连接(useSyncExternalStore):连接/断开会触发重渲染,
  // 从而驱动下方 syncMcpTargets 的 effect 重跑,使后端 MCP 注册表实时同步。
  const activeDbConns = useActiveDbConnections()
  const tunnelProfiles = useTunnelConnections()
  const rdpProfiles = useRdpConnections()
  const vncProfiles = useVncConnections()
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
  const [view, setView] = useState<string>(() => (restoreOpenTabs() ? 'workbench' : initView))
  const [prevView, setPrevView] = useState<string>('home')
  // Which Settings section to open to (theme | security | ai | ...).
  const [settingsSection, setSettingsSection] = useState<string>('appearance')
  // Start with no open tabs — the app lands on 'home' by default (clean, no
  // auto-opened mock host/db). Tabs are created on demand by openConn/openLiveTab.
  const [tabs, setTabs] = useState<Tab[]>(() => restoreOpenTabs()?.tabs ?? [])
  const [activeTab, setActiveTab] = useState<string>(() => restoreOpenTabs()?.activeTab ?? '')
  // Pending unsaved-changes confirmation when closing a dirty remote-file tab.
  const [closeConfirm, setCloseConfirm] = useState<{ id: string; title: string } | null>(null)
  // Transient VNC passwords (connId → password), in-memory only — never persisted.
  const [vncSecrets, setVncSecrets] = useState<Record<string, string>>({})
  // Monotonic counter for unique tab ids. A connId can now own MULTIPLE tabs
  // (复制标签), so `tab-${connId}` is no longer unique — append a fresh seq.
  const tabSeq = useRef(0)
  const newTabId = (connId: string) => `tab-${connId}-${tabSeq.current++}`
  // MRU: connId -> the tab id last active for that connection. Tracked via an
  // effect (below) so we don't have to touch the many setActiveTab call sites.
  const mruRef = useRef<Record<string, string>>({})
  const [activePanel, setActivePanel] = useState<string>('ai')
  const [panelOpen, setPanelOpen] = useState<boolean>(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)
  const [detailConn, setDetailConn] = useState<Connection | null>(null)
  const [showNew, setShowNew] = useState<boolean>(false)
  // EDIT mode for the DB NewConnectionModal (null = create/new DB profile).
  const [editProfile, setEditProfile] = useState<DbProfile | null>(null)
  // Sidebar vault filter: favorite | host | db.
  const [sidebarFilter, setSidebarFilter] = useState<string>('favorite')
  // EDIT mode for the SSH NewConnectionModal (null = create/new host profile).
  const [editing, setEditing] = useState<ConnectionProfile | null>(null)
  // Pending delete confirmation (styled ConfirmModal).
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  // Pending BATCH delete confirmation (侧栏批量维护)。
  const [pendingBatchDelete, setPendingBatchDelete] = useState<Connection[] | null>(null)
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
  // Persist open tabs so they survive an app restart.
  useEffect(() => { saveOpenTabs(tabs, activeTab) }, [tabs, activeTab])

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
  // Refresh DB history whenever the History panel is opened. Resolve a friendly
  // connection name for each row: prefer the name persisted with the entry (works
  // for closed connections), then the live connId→name map, finally the raw
  // connId. `engine`/`profileId` ride along for the panel's type filter + delete.
  useEffect(() => {
    if (!(activePanel === 'history' && panelOpen)) return
    const nameByConnId: Record<string, string> = Object.fromEntries(
      listActiveDbConnections().map(a => [a.connId, a.name]),
    )
    getDbHistory('')
      .then(items => setDbHistory(items.map(h => ({ ...h, target: h.name ?? nameByConnId[h.target] ?? h.target }))))
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
  const [pendingTrust, setPendingTrust] = useState<{ args: SshConnectArgs; name: string; sessionId: string; fingerprint: string; profileId?: string } | null>(null)
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
  // 启用本地登录验证时，每次加载都从「未登录」起步（null → 显示 AuthGate）。
  // 不能用 sessionStorage 恢复会话来跳过登录：vault 的解密密钥仅存内存（见
  // state/vault.ts），重载/重启后必然丢失。若仅凭 sessionStorage 认为"已登录"，
  // 就会进入"会话有效但 vault 已锁"的半状态——缓存的连接密码无法解密，于是每次
  // 重连都要重输密码。要求登录才能重新派生 vault 密钥，凭据记忆才真正生效。
  const [sessionUser, setSessionUser] = useState<string | null>(() =>
    localStorage.getItem('catio-auth') === '1' ? null : '__open'
  )

  const locked = authEnabled && !sessionUser
  // the first account created owns the seed vault; other users get an isolated (empty) vault
  const ownsVault = !authEnabled || sessionUser === ownerUser || sessionUser === '__open'
  // Silently reconnect restored tabs ONCE the vault is usable (auth users have no cached
  // credentials until they log in, and the vault key is lost on restart — so this must be
  // driven by unlock, not mount). No-op without persistent creds; the disconnected terminal
  // then shows a "reconnect from the sidebar" notice.
  const restoredReconnectRef = useRef(false)
  useEffect(() => {
    if (restoredReconnectRef.current || locked) return
    restoredReconnectRef.current = true
    const r = restoreOpenTabs()
    if (!r) return
    const seen = new Set<string>()
    for (const tb of r.tabs) {
      if (seen.has(tb.connId)) continue
      seen.add(tb.connId)
      if (profiles.some(p => p.id === tb.connId)) {
        void ensureSession(tb.connId) // SSH: silent reconnect with cached creds
      } else {
        const dbp = dbProfiles.find(p => p.id === tb.connId)
        if (dbp) void (async () => {
          const sec = getSessionSecret(dbp.id) ?? (await cachedSecret(dbp.id))
          if (sec) { try { await connectDbProfile(dbp, sec) } catch { /* stays dormant until user connects */ } }
        })()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked])
  // Vault = real saved SSH host profiles + real saved DB connections (reactive).
  // Mock DB connections are excluded — only real saved profiles drive DB rows now.
  // Real saved SSH host profiles (localStorage) → host Connection rows.
  // The logged-in server user's name — used to badge connections OWNED BY SOMEONE ELSE (only an
  // admin ever sees those; for a normal user every item is their own, so no badge).
  const selfName = serverAuth.user?.username
  const ownerTag = (p: { __ownerName?: string }) => (p.__ownerName && p.__ownerName !== selfName ? { ownerName: p.__ownerName } : {})
  const profileConns: Connection[] = profiles.map(p => ({
    id: p.id,
    group: p.group ?? '',
    kind: 'host',
    name: p.name,
    sub: `${p.user}@${p.host}:${p.port}`,
    icon: 'server',
    status: sessionMap[p.id] ? 'up' : 'idle',
    proto: 'ssh',
    ...(p.notes ? { notes: p.notes } : {}),
    ...(p.os ? { os: p.os } : {}),
    ...ownerTag(p),
  }))
  // Real saved DB connections (reactive) → db Connection rows.
  const activeProfileIds = new Set(listActiveDbConnections().map(a => a.profileId))
  const realDbConns = dbProfiles.map(p => ({ ...dbProfileToConnection(p, activeProfileIds.has(p.id)), ...ownerTag(p) }))
  // Saved port-forward connections (C2) → tunnel Connection rows.
  const tunnelConns: Connection[] = tunnelProfiles.map(p => ({
    id: p.id,
    group: p.group ?? '',
    kind: 'tunnel',
    name: p.name,
    sub: p.kind === 'D' ? `SOCKS · ${p.bind}` : `${p.kind} · ${p.bind} → ${p.target ?? ''}`,
    icon: 'git-branch',
    status: 'idle',
    ...ownerTag(p),
  }))
  // Saved RDP connections → rdp Connection rows (open = launch system RDP client).
  const rdpConns: Connection[] = rdpProfiles.map(p => ({
    id: p.id,
    group: p.group ?? '',
    kind: 'rdp',
    name: p.name,
    sub: `RDP · ${p.user ? p.user + '@' : ''}${p.host}:${p.port}`,
    icon: 'monitor',
    status: 'idle',
    host: p.host,
    port: p.port,
    ...(p.user ? { user: p.user } : {}),
    ...ownerTag(p),
  }))
  // Saved VNC connections → vnc Connection rows (open = embedded VNC session).
  const vncConns: Connection[] = vncProfiles.map(p => ({
    id: p.id,
    group: p.group ?? '',
    kind: 'vnc',
    name: p.name,
    sub: `VNC · ${p.host}:${p.port}`,
    icon: 'monitor',
    status: 'idle',
    host: p.host,
    port: p.port,
    ...ownerTag(p),
  }))
  const vaultConns = ownsVault ? [...profileConns, ...realDbConns, ...tunnelConns, ...rdpConns, ...vncConns] : []
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
  // Server mode: secrets live ON THE SERVER (encrypted with CATIO_MASTER_KEY, keyed by the logged-in
  // user) — works over plain-HTTP LAN where browser WebCrypto is unavailable, so a saved connection
  // opens password-free after login. Desktop: the local WebCrypto vault, gated on auth + unlock.
  async function cachedSecret(profileId: string): Promise<string | null> {
    if (isServer()) return serverAuth.user ? secretRecall(profileId) : null
    if (!authEnabled || !sessionUser || sessionUser === '__open' || !isVaultUnlocked()) return null
    return recallSecret(sessionUser, profileId)
  }
  function rememberConnSecret(profileId: string, secret: string) {
    if (isServer()) {
      if (serverAuth.user && secret) void secretRemember(profileId, secret)
      return
    }
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
  }, [dbProfiles, sessionMap, liveConns, activeDbConns])

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

  // Track the MRU tab per connection: whenever the active tab resolves to a Tab,
  // remember it as that connection's most-recently-used. Avoids instrumenting the
  // dozens of setActiveTab call sites.
  useEffect(() => {
    const tab = tabs.find(tb => tb.id === activeTab)
    if (tab) mruRef.current[tab.connId] = activeTab
  }, [activeTab, tabs])

  // Resolve the tab a card click should activate for a connection: prefer the
  // stored MRU id if it still exists among this conn's tabs; else the last one;
  // undefined if the conn has no tabs.
  function mruTabIdForConn(connId: string): string | undefined {
    const candidates = tabs.filter(t => t.connId === connId)
    if (!candidates.length) return undefined
    const mru = mruRef.current[connId]
    if (mru && candidates.some(t => t.id === mru)) return mru
    return candidates[candidates.length - 1].id
  }

  // Compute a 复制标签 title: strip any trailing ` (k)` to get the base, then pick
  // the smallest n ≥ 1 not already used by a sibling (same connId) titled
  // `${base} (${n})`. The original (unnumbered) tab keeps its name; copies start at (1).
  function computeDupTitle(source: Tab): string {
    const base = source.title.replace(/ \(\d+\)$/, '')
    const used = new Set<number>()
    for (const t of tabs) {
      if (t.connId !== source.connId) continue
      const m = t.title.match(/^(.*) \((\d+)\)$/)
      if (m && m[1] === base) used.add(Number(m[2]))
    }
    let n = 1
    while (used.has(n)) n += 1
    return `${base} (${n})`
  }

  // 复制标签: clone the source tab (same kind/connId/sessionId) under a fresh id with
  // a numbered title, insert it immediately to the right of the source, and activate
  // it. Terminal copies share the sessionId but each TerminalPane opens its own PTY
  // channel (a fresh shell); DB copies share the live connection via a new workbench.
  function duplicateTab(sourceId: string) {
    setTabs(prev => {
      const idx = prev.findIndex(tb => tb.id === sourceId)
      if (idx < 0) return prev
      const source = prev[idx]
      const dup: Tab = {
        id: newTabId(source.connId),
        kind: source.kind,
        connId: source.connId,
        title: computeDupTitle(source),
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      }
      const next = [...prev]
      next.splice(idx + 1, 0, dup)
      setActiveTab(dup.id)
      return next
    })
  }

  // 重命名标签: update the tab's title. Empty/whitespace-only titles are ignored.
  function renameTab(id: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    setTabs(prev => prev.map(tb => tb.id === id ? { ...tb, title: trimmed } : tb))
  }

  // Open (or re-focus) a remote-file editor tab. The id is stable per (connId, path)
  // so re-opening the same file reuses its tab; sessionId is refreshed on reconnect.
  function openRemoteFile(connId: string, sessionId: string | undefined, filePath: string) {
    const id = `rfile:${connId}:${filePath}`
    const title = filePath.split(/[/\\]/).pop() || filePath
    setTabs(prev => prev.some(tb => tb.id === id)
      ? prev.map(tb => tb.id === id ? { ...tb, sessionId } : tb)
      : [...prev, { id, kind: 'remote-file', connId, title, sessionId, path: filePath }])
    setActiveTab(id)
    setView('workbench')
  }

  // Open a non-SSH terminal (local shell / serial / telnet) in a fresh tab. No SSH
  // session — LocalTerminalPane drives the transport over the term_local_* IPC.
  function openTerminalConn(desc: { proto: 'local' | 'serial' | 'telnet' | 'mosh'; name: string; host?: string; port?: number; user?: string; serialPort?: string; baud?: number }) {
    const connId = `term-${desc.proto}-${tabSeq.current++}`
    const sub = desc.proto === 'serial'
      ? `${desc.serialPort ?? ''} · ${desc.baud ?? 115200}`
      : desc.proto === 'telnet'
        ? `telnet ${desc.host ?? ''}:${desc.port ?? 23}`
        : desc.proto === 'mosh'
          ? `mosh ${desc.user ? desc.user + '@' : ''}${desc.host ?? ''}`
          : 'local shell'
    const conn: Connection = {
      id: connId, group: '', kind: 'host', proto: desc.proto, name: desc.name, sub,
      icon: desc.proto === 'serial' ? 'hard-drive' : (desc.proto === 'telnet' || desc.proto === 'mosh') ? 'globe' : 'terminal',
      status: 'up',
      ...(desc.host ? { host: desc.host } : {}),
      ...(desc.port ? { port: desc.port } : {}),
      ...(desc.user ? { user: desc.user } : {}),
      ...(desc.serialPort ? { serialPort: desc.serialPort } : {}),
      ...(desc.baud ? { baud: desc.baud } : {}),
    }
    setLiveConns(prev => ({ ...prev, [connId]: conn }))
    const tabId = newTabId(connId)
    setTabs(prev => [...prev, { id: tabId, kind: 'terminal', connId, title: desc.name }])
    setActiveTab(tabId)
    setView('workbench')
  }

  // Open a VNC remote-desktop tab. Password is kept transient (in-memory) only.
  function openVncConn(desc: { name: string; host: string; port: number; password: string }) {
    const connId = `vnc-${tabSeq.current++}`
    const conn: Connection = {
      id: connId, group: '', kind: 'host', proto: 'vnc', name: desc.name,
      sub: `vnc ${desc.host}:${desc.port}`, icon: 'monitor', status: 'up',
      host: desc.host, port: desc.port,
    }
    setLiveConns(prev => ({ ...prev, [connId]: conn }))
    setVncSecrets(prev => ({ ...prev, [connId]: desc.password }))
    const tabId = newTabId(connId)
    setTabs(prev => [...prev, { id: tabId, kind: 'terminal', connId, title: desc.name }])
    setActiveTab(tabId)
    setView('workbench')
  }

  // Build a display Connection for a live SSH session and open its terminal tab.
  function openLiveTab(args: SshConnectArgs, name: string, sessionId?: string, profileId?: string) {
    const prof = profileId
      ? loadProfiles().find(p => p.id === profileId)
      : loadProfiles().find(p => p.host === args.host && p.port === args.port && p.user === args.user)
    const connId = profileId ?? `live-${args.host}:${args.port}-${args.user}`
    const conn: Connection = {
      id: connId,
      group: prof?.group ?? '',
      kind: 'host',
      name,
      sub: `${args.user}@${args.host}:${args.port}`,
      icon: 'server',
      status: 'up',
      proto: 'ssh',
      ...(prof?.notes ? { notes: prof.notes } : {}),
      ...(prof?.os ? { os: prof.os } : {}),
    }
    setLiveConns(prev => ({ ...prev, [connId]: conn }))
    if (sessionId) setSessionMap(prev => ({ ...prev, [connId]: sessionId }))
    // One conn can own multiple tabs now: if it already has a tab, re-activate its
    // MRU tab (and refresh its sessionId) instead of creating another; only the
    // first connect (no existing tab) creates a fresh terminal tab.
    const existingTabId = mruTabIdForConn(connId)
    if (existingTabId) {
      setTabs(prev => prev.map(tb => tb.id === existingTabId ? { ...tb, sessionId } : tb))
      setActiveTab(existingTabId)
    } else {
      const tabId = newTabId(connId)
      setTabs(prev => [...prev, { id: tabId, kind: 'terminal', connId, title: name, sessionId }])
      setActiveTab(tabId)
    }
    setView('workbench')
    // Surface any newly-saved profile in the vault (saveProfile ran in the modal).
    reloadProfiles()
    // Record this as a recent session for the home screen. SSH vault entries are
    // keyed by the saved PROFILE id (not the live `live-…` connId), so resolve the
    // matching profile by host/port/user from the freshest store — this is what the
    // home resolves against, and it persists across restarts.
    const pid = prof?.id
    if (pid) { recordRecentSession(pid); setRecentSessions(loadRecentSessions()) }

    // Detect the remote OS so the sidebar/home glyph shows the real OS logo. Runs
    // once per connect; persists onto the profile (survives restart) and updates the
    // live conn immediately. Best-effort — failures leave the generic host icon.
    if (sessionId) {
      void sshDetectOs(sessionId).then(os => {
        if (!os) return
        setLiveConns(prev => (prev[connId] ? { ...prev, [connId]: { ...prev[connId], os } } : prev))
        const profile = loadProfiles().find(p => p.id === pid)
        if (profile && profile.os !== os) { try { saveProfile({ ...profile, os }); reloadProfiles() } catch { /* ignore */ } }
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
          // Stable profile id (when this live conn maps to a saved host) so the
          // entry can be deleted alongside its connection profile.
          ...(pid ? { profileId: pid } : {}),
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
    if (!isTauri() && !isServer()) {
      // Demo path (dev/test only): no IPC, just open a demo terminal tab (no sessionId).
      // In server mode we fall through to the real connect (sshConnect over HTTP → WS terminal).
      openLiveTab(args, display.name, undefined, display.profileId)
      return true
    }
    // If the modal already supplied a target secret, the jump secret (if any) also
    // came from the form — connect directly (skip all prompts).
    if (args.secret && args.secret.length > 0) {
      return performConnect(args, display.name, args.secret, display.profileId)
    }
    // 扫描导入的 ✓authed 主机：本次会话内存里存有命中凭证，首连直连免再输。
    // 注意用 !== undefined 判断：私钥命中存的是空口令标记（''），也应直连（用私钥免口令）。
    if (display.profileId) {
      const sess = getSessionSecret(display.profileId)
      if (sess !== undefined) {
        return performConnect(args, display.name, sess, display.profileId)
      }
    }
    // Auth-gated cache: reuse a remembered secret (no prompt). Skipped when a jump
    // host still needs its own secret (we only cache the target secret).
    if (display.profileId && (!args.jump || args.jump.secret)) {
      const cached = await cachedSecret(display.profileId)
      if (cached) {
        return performConnect(args, display.name, cached, display.profileId)
      }
    }
    // Reconnect path: collect secrets interactively.
    // If a jump host is configured AND it has no secret yet, collect jump secret first.
    if (args.jump && !args.jump.secret) {
      setPendingJumpSecret({ args, name: display.name, profileId: display.profileId })
      return false
    }
    // Otherwise collect target secret.
    setPendingConnect({ args, name: display.name, profileId: display.profileId })
    return false
  }

  // Secret collected → call sshConnect; route to trust prompt / success / error.
  // args.jump (with its secret) is forwarded intact to sshConnect.
  async function performConnect(args: SshConnectArgs, name: string, secret: string, profileId?: string): Promise<boolean> {
    // Immediate feedback: show the connecting overlay before the (1–2s) await.
    setConnecting(name)
    try {
      const result = await sshConnect({ ...args, secret, jump: args.jump }, name)
      // Auth succeeded → the secret is valid; cache it (when auth + vault allow).
      if (profileId) rememberConnSecret(profileId, secret)
      if (result.hostKeyTrusted === false) {
        setPendingTrust({ args, name, sessionId: result.sessionId, fingerprint: result.hostKeyFingerprint, profileId })
        return false
      }
      openLiveTab(args, name, result.sessionId, profileId)
      return true
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
      return false
    } finally {
      setConnecting(null)
    }
  }

  // Trust accepted → record host key, then open the (already-established) session.
  async function trustAndOpen(p: NonNullable<typeof pendingTrust>) {
    try {
      await sshTrustHost(`${p.args.host}:${p.args.port}`, p.fingerprint)
    } catch { /* best-effort — proceed even if recording fails */ }
    openLiveTab(p.args, p.name, p.sessionId, p.profileId)
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
    // Saved RDP connection: launch the system RDP client.
    if (conn.kind === 'rdp') {
      const rp = rdpProfiles.find(p => p.id === conn.id)
      if (rp) void rdpLaunch(rp.host, rp.port, rp.user ?? '').catch(e => setConnectError(String((e as { message?: string } | null)?.message ?? e)))
      return
    }
    // Saved VNC connection: open an embedded VNC tab, reusing the cached password.
    if (conn.kind === 'vnc') {
      const vp = vncProfiles.find(p => p.id === conn.id)
      if (!vp) return
      const pw = getSessionSecret(vp.id) ?? (await cachedSecret(vp.id)) ?? ''
      openVncConn({ name: vp.name, host: vp.host, port: vp.port, password: pw })
      return
    }
    // Saved port-forward (C2): ensure the host SSH session, then open the tunnel.
    if (conn.kind === 'tunnel') {
      const tp = tunnelProfiles.find(p => p.id === conn.id)
      if (!tp) return
      const sid = await ensureSession(tp.hostProfileId)
      if (sid === 'needs-auth' || sid === 'failed') {
        // Host not connected and can't connect silently → connect it interactively first.
        const hostConn = vaultConns.find(c => c.id === tp.hostProfileId)
        if (hostConn) void openConn(hostConn)
        return
      }
      try {
        await tunnelOpen(sid, { kind: tp.kind, bind: tp.bind, target: tp.kind === 'D' ? null : (tp.target ?? null) })
        setActivePanel('tunnels')
        setPanelOpen(true)
      } catch (e) { setConnectError(String((e as { message?: string } | null)?.message ?? e)) }
      return
    }
    // DB connection: if already live, open its SQL workbench tab; otherwise reuse a
    // cached secret (auth-gated) or prompt for the password and connect. Falls back
    // to the details panel only if the saved profile can't be resolved.
    if (conn.kind === 'db') {
      const active = listActiveDbConnections().find(a => a.profileId === conn.id)
      if (active) {
        // Already-live DB: activate this conn's MRU tab if any, else open one.
        const existingTabId = mruTabIdForConn(conn.id)
        if (existingTabId) {
          setActiveTab(existingTabId)
        } else {
          const tabId = newTabId(conn.id)
          setTabs(prev => [...prev, { id: tabId, kind: 'sql', connId: conn.id, title: conn.name }])
          setActiveTab(tabId)
        }
        setView('workbench')
      } else {
        const dbp = dbProfiles.find(p => p.id === conn.id)
        if (dbp) {
          // 扫描导入的 ✓authed 库：本次会话内存里存有命中密码,首连直连免再输。
          const sess = getSessionSecret(dbp.id)
          if (sess) {
            try { await connectDbProfile(dbp, sess); return }
            catch { /* 会话密钥失效则继续走缓存/提示 */ }
          }
          const cached = await cachedSecret(dbp.id)
          if (cached) {
            try { await connectDbProfile(dbp, cached); return }
            catch (err) {
              // The cached secret failed to connect. Surface WHY in the prompt
              // instead of silently dropping to a blank password box (which
              // looks like "the password was never cached"). Dev runtime w/o a
              // backend is the one case we still fall through quietly.
              const msg = dbErrMsg(err)
              if (!msg.includes('Tauri runtime')) {
                setDbPromptError(/auth|password/i.test(msg) ? t('modals.connectErrorAuth') : msg)
                setPendingDbConnect(dbp)
                return
              }
            }
          }
          setDbPromptError(null); setPendingDbConnect(dbp)
        } else openDetail(conn)
      }
      return
    }
    // Fallback: live display host conns without a saved profile just open a tab.
    // Activate this conn's MRU tab if one exists, else create a fresh terminal tab.
    const existingTabId = mruTabIdForConn(conn.id)
    if (existingTabId) {
      setActiveTab(existingTabId)
    } else {
      const tabId = newTabId(conn.id)
      setTabs(prev => [...prev, {
        id: tabId,
        kind: 'terminal',
        connId: conn.id,
        title: conn.name,
      }])
      setActiveTab(tabId)
    }
    setView('workbench')
  }

  // ---- 多主机广播候选 (Multi-host broadcast targets) ----
  // 真实广播候选：合并 live SSH 会话 (liveConns) 与已保存的 host profiles，按 id 去重，
  // 仅取 kind==='host'。profile→Connection 镜像 openLiveTab 里的构造方式（sub=user@host:port、
  // proto='ssh'），status 由 sessionMap[id] 是否存在决定。
  const mxCandidates: Connection[] = (() => {
    const byId = new Map<string, Connection>()
    // 已保存的 host profiles（基础态，可被 live 覆盖）
    for (const p of profiles) {
      byId.set(p.id, {
        id: p.id,
        group: p.group ?? '',
        kind: 'host',
        name: p.name,
        sub: `${p.user}@${p.host}:${p.port}`,
        icon: 'server',
        status: sessionMap[p.id] ? 'up' : 'down',
        proto: 'ssh',
        ...(p.os ? { os: p.os } : {}),
      })
    }
    // 当前 live 连接（覆盖同 id 的 profile，携带最新状态/图标）
    for (const c of Object.values(liveConns)) {
      if (c.kind !== 'host') continue
      byId.set(c.id, { ...c, status: sessionMap[c.id] ? 'up' : 'down' })
    }
    return [...byId.values()].filter(c => c.kind === 'host')
  })()

  // ensureSession — 静默路径：为广播目标确保一个可用的 SSH sessionId。
  // 绝不弹任何交互 modal；需认证/失败按契约返回字符串字面量。
  async function ensureSession(connId: string): Promise<string | 'needs-auth' | 'failed'> {
    // 1) 已有 live 会话 → 直接复用，绝不重连/重开标签。
    const existing = sessionMap[connId]
    if (existing) return existing
    // 2) 取该 profile，复用 openConn 的 profile→args 构造逻辑做静默连接。
    const profile = profiles.find(p => p.id === connId)
    if (!profile) return 'needs-auth'
    if (!isTauri() && !isServer()) return 'failed'
    const args: SshConnectArgs = {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      auth: profile.auth,
      jump: profile.jump,
    }
    // 仅当目标 secret 已缓存时才尝试静默连接。jump host 的 secret 从不入缓存
    // （见 connectProfile：we only cache the target secret），故有 jump 时静默路径
    // 无法补齐其凭据 → 返回 'needs-auth'，交给正常交互流程收集。
    if (profile.jump) return 'needs-auth'
    const cached = await cachedSecret(profile.id)
    if (!cached) return 'needs-auth'
    try {
      const result = await sshConnect({ ...args, secret: cached }, profile.name)
      // 首次信任未建立 → 静默路径不能弹信任框：断开并返回 'needs-auth'。
      if (result.hostKeyTrusted === false) {
        sshDisconnect(result.sessionId).catch(() => { /* best-effort */ })
        return 'needs-auth'
      }
      // 成功 → openLiveTab 注册 sessionMap 并开标签，返回新 sessionId。
      openLiveTab(args, profile.name, result.sessionId, profile.id)
      return result.sessionId
    } catch {
      return 'failed'
    }
  }

  // onConnectTarget — 结果面板「连接」按钮：走正常交互建连。
  function onConnectTarget(connId: string) {
    const c = mxCandidates.find(x => x.id === connId)
    if (c) void openConn(c)
  }

  // tabs/chanMap 的最新值镜像到 ref —— sendToPty 在 await 轮询期间需读到刷新后的
  // chan（自动建连的新标签 PTY 通道注册有延迟），闭包里的 state 会过期，必须用 ref。
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const chanMapRef = useRef(chanMap)
  chanMapRef.current = chanMap

  // sendToPty — 把命令写进目标会话的交互式 PTY，与用户手动输入完全同一通道：
  // 命令与执行结果会出现在该会话对应的终端标签里（广播明细去标签看）。命令末尾补 \r
  // 触发执行。自动建连的新标签 PTY 通道需片刻才注册，故轮询等待最多 ~6s。
  // 不在此处强制 resize：目标按自身终端的真实宽度渲染（隐藏标签的尺寸守卫已避免被压成 ~0 宽），
  // 与手工在该标签输入一致；强行只改 PTY 不改 xterm 反而会造成宽度错位、折行错乱。
  async function sendToPty(sessionId: string, cmd: string): Promise<boolean> {
    const resolveChan = (): string | undefined => {
      const tab = tabsRef.current.find(tb => tb.sessionId === sessionId && chanMapRef.current[tb.id])
      return tab ? chanMapRef.current[tab.id] : undefined
    }
    let chan = resolveChan()
    for (let i = 0; i < 60 && !chan; i++) {
      await new Promise(r => setTimeout(r, 100))
      chan = resolveChan()
    }
    if (!chan) return false
    try {
      const { termWrite } = await import('./services/ssh')
      await termWrite(sessionId, chan, btoa(unescape(encodeURIComponent(cmd + '\r'))))
      return true
    } catch {
      return false
    }
  }

  function terminalTabConnected(tab: Tab): boolean {
    if (tab.kind !== 'terminal') return false
    if (!isTauri() && !isServer()) return true
    const conn = liveConns[tab.connId] ?? vaultConns.find(c => c.id === tab.connId) ?? D.byId[tab.connId] ?? null
    if (conn && (conn.proto === 'local' || conn.proto === 'serial' || conn.proto === 'telnet' || conn.proto === 'mosh' || conn.proto === 'vnc')) return true
    return !!tab.sessionId && Object.values(sessionMap).includes(tab.sessionId)
  }

  function profileForTerminalTab(tab: Tab, conn: Connection | null): ConnectionProfile | undefined {
    const direct = profiles.find(p => p.id === tab.connId || p.id === conn?.id)
    if (direct) return direct
    return profiles.find(p => {
      const liveId = `live-${p.host}:${p.port}-${p.user}`
      const sub = `${p.user}@${p.host}:${p.port}`
      return tab.connId === liveId || conn?.id === liveId || conn?.sub === sub
    })
  }

  function markSshSessionClosed(sessionId: string) {
    const closedTabIds = tabsRef.current.filter(tb => tb.sessionId === sessionId).map(tb => tb.id)
    const closedConnIds = new Set<string>([
      ...Object.entries(sessionMap).filter(([, sid]) => sid === sessionId).map(([connId]) => connId),
      ...tabsRef.current.filter(tb => tb.sessionId === sessionId).map(tb => tb.connId),
    ])
    const unlisten = historyUnlisteners.current[sessionId]
    if (unlisten) {
      unlisten()
      delete historyUnlisteners.current[sessionId]
    }
    setSessionMap(prev => {
      const next = { ...prev }
      for (const [connId, sid] of Object.entries(prev)) {
        if (sid === sessionId) delete next[connId]
      }
      return next
    })
    setTabs(prev => prev.map(tb => tb.sessionId === sessionId ? { ...tb, sessionId: undefined } : tb))
    setChanMap(prev => {
      const next = { ...prev }
      closedTabIds.forEach(id => { delete next[id] })
      return next
    })
    setLiveConns(prev => {
      let changed = false
      const next = { ...prev }
      closedConnIds.forEach(connId => {
        if (next[connId]) {
          next[connId] = { ...next[connId], status: 'down' }
          changed = true
        }
      })
      return changed ? next : prev
    })
    setDetailConn(prev => prev && closedConnIds.has(prev.id) ? { ...prev, status: 'idle' } : prev)
  }

  async function reconnectTerminalTab(tabId: string): Promise<boolean> {
    const tab = tabsRef.current.find(tb => tb.id === tabId)
    if (!tab || tab.kind !== 'terminal') return false
    const conn = liveConns[tab.connId] ?? vaultConns.find(c => c.id === tab.connId) ?? D.byId[tab.connId] ?? null
    const profile = profileForTerminalTab(tab, conn)
    if (!profile) {
      if (conn) void openConn(conn)
      return false
    }
    return connectProfile(
      { host: profile.host, port: profile.port, user: profile.user, auth: profile.auth, jump: profile.jump },
      { name: profile.name, profileId: profile.id },
    )
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
      // chanMap is keyed by tab.id; drop the closing tab's channel entry.
      const next = { ...prev }
      delete next[closing.id]
      return next
    })
  }
  function doCloseTab(id: string) {
    // Wipe the transient VNC password for this tab's conn (in-memory only).
    const closingTab = tabs.find(tb => tb.id === id)
    if (closingTab && vncSecrets[closingTab.connId] != null) {
      setVncSecrets(prev => { const n = { ...prev }; delete n[closingTab.connId]; return n })
    }
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
  // Guard: closing a remote-file tab with unsaved edits asks for confirmation first.
  function closeTab(id: string) {
    const tab = tabs.find(tb => tb.id === id)
    if (tab && tab.kind === 'remote-file' && tab.dirty) { setCloseConfirm({ id, title: tab.title }); return }
    doCloseTab(id)
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
    const mruId = mruTabIdForConn(conn.id)
    if (mruId) {
      setActiveTab(mruId)
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
    // Drop this profile's persisted query history too (req: 删连接同步删历史).
    void deleteDbHistoryForProfile(profile.id)
    setDbHistory(prev => prev.filter(h => h.profileId !== profile.id))
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
    // IMPORTANT: thread the FULL non-secret arg set via dbConnectArgsFromProfile —
    // driverProfile + options (else a reconnect loses MongoDB's
    // directConnection/authSource or a protocol-family variant connects as the base),
    // AND the SSL/TLS config (ssl/sslMode/caCertPath/sslRejectUnauthorized) — without
    // it the sidebar/home direct-connect path silently dropped TLS.
    const result = await dbConnect(dbConnectArgsFromProfile(profile, secret || undefined), profile.name)
    setActiveDbConnection(result, profile)
    // Auth succeeded → cache the secret (when auth + vault allow).
    rememberConnSecret(profile.id, secret)
    // 扫描导入的「需要认证」草稿：首次成功登录后清除标记（不再显示徽标）。
    if (profile.needsAuth) saveDbConnection({ ...profile, needsAuth: false })
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
    // A conn may own multiple tabs now — close every tab for this profile.
    const closing = tabs.filter(tb => tb.connId === profile.id).map(tb => tb.id)
    closing.forEach(id => closeTab(id))
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
    if (conn.kind === 'tunnel' || conn.kind === 'rdp' || conn.kind === 'vnc') { void openConn(conn); closeDetailPanel(); return }
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
    // chanMap is keyed by tab.id now; reapSession drops each closed tab's channel,
    // so a delete-by-sid here would be a no-op. A conn may own multiple tabs — close
    // every tab for this connId (snapshot ids first; closeTab mutates `tabs`).
    const closing = tabs.filter(tb => tb.connId === connId).map(tb => tb.id)
    closing.forEach(id => closeTab(id))
  }

  // 关闭会话 — disconnect the live session for this connection.
  function closeSessionForConn(conn: Connection) {
    teardownSession(conn.id)
    setDetailConn(prev => prev && prev.id === conn.id ? { ...prev, status: 'idle' } : prev)
  }

  // 删除 (confirmed) — remove the profile, tear down any session, close the panel.
  function confirmDelete(conn: Connection) {
    if (conn.kind === 'tunnel') {
      try { removeTunnelConnection(conn.id) } catch { /* ignore */ }
      if (detailConn?.id === conn.id) { setDetailConn(null); setPanelOpen(false) }
      return
    }
    if (conn.kind === 'rdp') {
      try { removeRdpConnection(conn.id) } catch { /* ignore */ }
      if (detailConn?.id === conn.id) { setDetailConn(null); setPanelOpen(false) }
      return
    }
    if (conn.kind === 'vnc') {
      try { removeVncConnection(conn.id) } catch { /* ignore */ }
      if (detailConn?.id === conn.id) { setDetailConn(null); setPanelOpen(false) }
      return
    }
    if (sessionMap[conn.id]) teardownSession(conn.id)
    try { deleteProfile(conn.id) } catch { /* localStorage unavailable — ignore */ }
    // Drop this host's shell command history too (req: 删连接同步删历史).
    deleteHistoryForProfile(conn.id)
    setHistory(loadHistory())
    reloadProfiles()
    if (detailConn?.id === conn.id) { setDetailConn(null); setPanelOpen(false) }
  }

  // 批量维护：把选中连接移动到目标分组（''=未分组）。host/db 分别写回各自存储。
  function batchMoveToGroup(conns: Connection[], groupId: string) {
    for (const c of conns) {
      if (c.kind === 'host') {
        const p = profiles.find(x => x.id === c.id)
        if (p) { try { saveProfile({ ...p, group: groupId || undefined }) } catch { /* localStorage 不可用 */ } }
      } else if (c.kind === 'tunnel') {
        const p = tunnelProfiles.find(x => x.id === c.id)
        if (p) saveTunnelConnection({ ...p, group: groupId || undefined }) // 内部 notify()
      } else if (c.kind === 'rdp') {
        const p = rdpProfiles.find(x => x.id === c.id)
        if (p) saveRdpConnection({ ...p, group: groupId || undefined })
      } else if (c.kind === 'vnc') {
        const p = vncProfiles.find(x => x.id === c.id)
        if (p) saveVncConnection({ ...p, group: groupId || undefined })
      } else {
        const p = dbProfiles.find(x => x.id === c.id)
        if (p) saveDbConnection({ ...p, group: groupId || undefined }) // 内部 notify()
      }
    }
    reloadProfiles()
  }

  // 批量维护：删除选中连接（host 走 deleteProfile + 拆会话 + 删历史；db 复用 deleteDbProfile）。
  function batchDelete(conns: Connection[]) {
    for (const c of conns) {
      if (c.kind === 'host') {
        if (sessionMap[c.id]) teardownSession(c.id)
        try { deleteProfile(c.id) } catch { /* localStorage 不可用 */ }
        deleteHistoryForProfile(c.id)
      } else if (c.kind === 'tunnel') {
        try { removeTunnelConnection(c.id) } catch { /* ignore */ }
      } else if (c.kind === 'rdp') {
        try { removeRdpConnection(c.id) } catch { /* ignore */ }
      } else if (c.kind === 'vnc') {
        try { removeVncConnection(c.id) } catch { /* ignore */ }
      } else {
        const p = dbProfiles.find(x => x.id === c.id)
        if (p) deleteDbProfile(p)
      }
    }
    setHistory(loadHistory())
    reloadProfiles()
    if (detailConn && conns.some(c => c.id === detailConn.id)) { setDetailConn(null); setPanelOpen(false) }
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
  // The AI panel's "@ 选表" needs the BACKEND live connId, not the tab's profile
  // id (cur.connId). Resolve it the same way DbWorkbench does — first active
  // connection whose profileId matches the tab. Undefined for terminal tabs or
  // when the DB connection isn't live.
  const aiConnId = cur && cur.kind !== 'terminal'
    ? listActiveDbConnections().find(a => a.profileId === cur.connId)?.connId
    : undefined

  // Write text into the active terminal's live PTY channel (no trailing newline).
  async function insertToTerminal(code: string) {
    const sid = cur?.sessionId
    // chanMap is keyed by tab.id (not sessionId) so two terminal copies sharing one
    // sessionId resolve to their OWN channel — the insert lands in the active copy.
    const chan = cur ? chanMap[cur.id] : undefined
    if (!sid || !chan) return
    const { termWrite } = await import('./services/ssh')
    await termWrite(sid, chan, btoa(unescape(encodeURIComponent(code))))
  }
  const canInsert = !!(cur?.sessionId && chanMap[cur.id])
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

  async function sendAgentMessage(tabId: string, text: string, opts?: { hasSelection?: boolean }) {
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
    // Skip it when the message already carries user-selected text — the user
    // pointed at exactly the context they want, so dumping N more lines is noise.
    const termTail = prefs.termBufferEnabled && liveSessionId && !opts?.hasSelection
      ? readTermBufferTail(liveSessionId, prefs.termBufferLines)
      : ''
    const termBlock = termTail
      ? `\n\n当前终端最近输出（最多 ${prefs.termBufferLines} 行，供参考）:\n\`\`\`\n${termTail}\n\`\`\``
      : ''
    // Database tabs (kind !== 'terminal') get the engine-aware DB assistant prompt
    // so the model answers in the connection's real query syntax (mongo shell /
    // ES REST+DSL / SQL dialect) — runnable directly in the editor, not a CLI.
    const agentMode = tab.kind === 'terminal' ? 'shell' : 'sql'
    const tabEngine = vaultConns.find(c => c.id === tab.connId)?.engine
      ?? liveConns[tab.connId]?.engine ?? D.byId[tab.connId]?.engine
    const system: ChatMsg = {
      role: 'system',
      content: `${buildAgentSystemPrompt(agentMode, hostName, tabEngine)}${sysinfoBlock}${termBlock}`,
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
            filter={sidebarFilter} onFilterChange={setSidebarFilter}
            onBatchMove={batchMoveToGroup} onBatchDelete={conns => setPendingBatchDelete(conns)} />

          {/* main */}
          <div className="card-surface grow col" style={{ overflow: 'hidden', position: 'relative' }}>
            {/* view body */}
            <div className="grow col" style={{ minHeight: 0 }}>
              {view === 'home' && <HomeView onOpen={openConn} onNew={() => setShowNew(true)} onAutoScan={() => setView('scan')} canScan={!isServer() || !!serverAuth.user?.isAdmin} owned={ownsVault} userName={authEnabled ? currentName : ''} authEnabled={authEnabled} conns={vaultConns}
                recent={recentSessions.map(r => { const conn = vaultConns.find(c => c.id === r.connId); return conn ? { conn, ts: r.ts } : null }).filter((x): x is { conn: Connection; ts: number } => !!x)} />}

              {view === 'scan' && <ScanWizard onClose={() => setView('home')} onImported={() => { reloadProfiles() /* db 自动刷新 */ }}
                existingHostKeys={ownsVault ? profiles.map(p => `${p.host}:${p.port}`) : []}
                existingDbKeys={ownsVault ? dbProfiles.map(p => `${p.host}:${p.port}#${p.engineId ?? p.dbType}`) : []}
                onRememberSecret={rememberConnSecret} />}

              {/* tab bar — only in workbench when there are tabs */}
              {view === 'workbench' && tabs.length > 0 && (
                <WorkbenchTabs tabs={tabs} activeTab={activeTab} onActivate={setActiveTab} onClose={closeTab} onCloseOthers={closeOthers} onCloseAll={closeAll} onNew={() => setShowNew(true)} onDuplicate={duplicateTab} onRename={renameTab} terminalConnected={terminalTabConnected} />
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
                        {tab.kind === 'terminal' && tabConn && tabConn.proto === 'vnc' && (
                          <VncPane conn={tabConn} password={vncSecrets[tabConn.id] ?? ''} active={isShown} />
                        )}
                        {tab.kind === 'terminal' && tabConn && (tabConn.proto === 'local' || tabConn.proto === 'serial' || tabConn.proto === 'telnet' || tabConn.proto === 'mosh') && (
                          <LocalTerminalPane conn={tabConn} active={isShown} />
                        )}
                        {tab.kind === 'terminal' && tabConn?.proto !== 'vnc' && !(tabConn && (tabConn.proto === 'local' || tabConn.proto === 'serial' || tabConn.proto === 'telnet' || tabConn.proto === 'mosh')) && (
                          <SplitTerminal conn={tabConn} sessionId={tab.sessionId} active={isShown} connected={terminalTabConnected(tab)} resolveSessionId={resolveSessionId} mxCandidates={mxCandidates} ensureSession={ensureSession} onConnectTarget={onConnectTarget} sendToPty={sendToPty} onSessionClosed={markSshSessionClosed} onReconnect={() => reconnectTerminalTab(tab.id)} onChannel={(_sid, chan) => setChanMap(m => { const n = { ...m }; if (chan) n[tab.id] = chan; else delete n[tab.id]; return n })} />
                        )}
                        {tab.kind === 'sql' && tabConn && (
                          <DbWorkbench conn={tabConn} density={density} active={isShown} />
                        )}
                        {tab.kind === 'remote-file' && tab.path && (
                          <RemoteFileEditor sessionId={tab.sessionId} path={tab.path}
                            onDirtyChange={d => setTabs(prev => prev.map(tb => tb.id === tab.id && tb.dirty !== d ? { ...tb, dirty: d } : tb))} />
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
              {activePanel === 'ai' && <AIPanel onClose={() => setPanelOpen(false)} mode={aiMode} conn={curConn ?? undefined} connId={aiConnId} engine={curConn?.engine} attachment={aiAttachment} onClearAttachment={() => setAiAttachment(null)} onInsert={insertToTerminal} canInsert={canInsert} onOpenSettings={() => goSettings('ai')}
                conversation={activeConversation} busy={activeConvBusy} history={agentHistory}
                onSend={cur ? ((text, opts) => void sendAgentMessage(cur.id, text, opts)) : undefined}
                onAbort={cur ? (() => agentAborts.current[cur.id]?.abort()) : undefined}
                onNewConversation={cur ? (() => newAgentConversation(cur.id)) : undefined}
                onRestoreConversation={cur ? (convId => restoreConversation(cur.id, convId)) : undefined}
                onDeleteConversation={cur ? (convId => deleteAgentConversation(cur.id, convId)) : undefined} />}
              {activePanel === 'sftp' && <SftpPanel onClose={() => setPanelOpen(false)} conn={curConn ?? undefined} sessionId={cur?.sessionId} onEditFile={p => { if (cur) openRemoteFile(cur.connId, cur.sessionId, p) }} />}
              {activePanel === 'monitor' && <MonitorPanel onClose={() => setPanelOpen(false)} sessionId={cur?.sessionId} />}
              {activePanel === 'tunnels' && <TunnelsPanel onClose={() => setPanelOpen(false)} sessionId={cur?.sessionId} activeConnId={cur?.connId} profiles={profiles}
                onSaveProfile={cur ? (kind, bind, target, name) => {
                  // Resolve the active tab's (live) connId back to a STABLE saved profile id,
                  // so the forward can re-establish its host session after restart. Falls back
                  // to the live connId (works while the host stays connected) if unresolved.
                  const liveConn = liveConns[cur.connId] ?? vaultConns.find(c => c.id === cur.connId)
                  let hostProfileId = cur.connId
                  const sub = liveConn?.sub ?? ''
                  const at = sub.indexOf('@')
                  if (at >= 0) {
                    const user = sub.slice(0, at)
                    const hp = sub.slice(at + 1)
                    const colon = hp.lastIndexOf(':')
                    const host = colon > 0 ? hp.slice(0, colon) : hp
                    const port = colon > 0 ? Number(hp.slice(colon + 1)) : 22
                    const match = loadProfiles().find(p => p.host === host && p.port === port && p.user === user)
                    if (match) hostProfileId = match.id
                  }
                  saveTunnelConnection({ id: generateTunnelId(), name, kind, bind, target: target || undefined, hostProfileId })
                } : undefined} />}
              {activePanel === 'snippets' && <SnippetsPanel onClose={() => setPanelOpen(false)} snippets={snippets} onChange={() => setSnippets(loadSnippets())} onInsert={insertToTerminal} canInsert={canInsert} canInsertEditor={canInsertEditor} />}
              {activePanel === 'history' && <HistoryPanel onClose={() => setPanelOpen(false)} onAddSnippet={addSnippet} items={mergedHistory} onClear={() => { clearHistory(); setHistory([]); setDbHistory([]); void clearDbHistory() }}
                // History is scoped to the active tab: no active tab → empty hint;
                // a host tab → shell history; a DB tab → that engine's SQL history.
                noActiveConnection={!cur}
                activeKind={cur ? (cur.kind === 'terminal' ? 'shell' : 'sql') : undefined}
                activeEngine={cur && cur.kind === 'sql' ? curConn?.engine : undefined}
                onDelete={h => {
                  // Route the delete to the right store by kind: SQL queries live in
                  // the backend history file; shell commands live in localStorage.
                  if (h.kind === 'sql') { setDbHistory(prev => prev.filter(x => x.id !== h.id)); void deleteDbHistory(h.id) }
                  else { deleteHistory(h.id); setHistory(loadHistory()) }
                }}
                onPruneOrphans={ids => {
                  // Garbage history of deleted DB connections (legacy rows with no
                  // persisted name/profileId, still showing a raw connId). Drop from
                  // the view immediately, then delete each from the backend file.
                  const idSet = new Set(ids)
                  setDbHistory(prev => prev.filter(h => !idSet.has(h.id)))
                  void (async () => { for (const id of ids) await deleteDbHistory(id) })()
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
          <IconRail active={activePanel} onSelect={selectPanel} panelOpen={panelOpen} onMcp={() => { setSettingsSection('mcp'); if (view !== 'settings') setPrevView(view); setView('settings') }} />
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
          onOpenTerminal={openTerminalConn}
          onSaveVnc={d => {
            // Persist as a reusable sidebar connection, remember the password (session +
            // vault), then open the embedded VNC tab.
            const id = generateVncId()
            saveVncConnection({ id, name: d.name, host: d.host, port: d.port, ...(d.group ? { group: d.group } : {}) })
            if (d.password) { setSessionSecret(id, d.password); rememberConnSecret(id, d.password) }
            openVncConn({ name: d.name, host: d.host, port: d.port, password: d.password })
          }}
          onSaveRdp={d => {
            // Persist as a reusable sidebar connection, then launch the system RDP client.
            saveRdpConnection({ id: generateRdpId(), name: d.name, host: d.host, port: d.port, ...(d.user ? { user: d.user } : {}), ...(d.group ? { group: d.group } : {}) })
            void rdpLaunch(d.host, d.port, d.user).catch(e => setConnectError(String((e as { message?: string } | null)?.message ?? e)))
          }}
          onConnected={(profile, secret) => {
            if (secret) rememberConnSecret(profile.id, secret)
            bumpDbActive()
            syncMcpTargets()
            void openConn(dbProfileToConnection(profile, true))
          }}
        />
      )}

      {closeConfirm && (
        <ConfirmModal
          title={t('remoteFile.closeUnsavedTitle')}
          message={t('remoteFile.closeUnsavedBody', { name: closeConfirm.title })}
          confirmLabel={t('remoteFile.closeDiscard')}
          danger
          onConfirm={() => { const c = closeConfirm; setCloseConfirm(null); doCloseTab(c.id) }}
          onCancel={() => setCloseConfirm(null)}
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

      {pendingBatchDelete && (
        <ConfirmModal
          title={t('modals.deleteConfirmTitle')}
          message={t('modals.batchDeleteConfirmMsg', { n: pendingBatchDelete.length })}
          confirmLabel={t('modals.confirmDelete')}
          danger
          onConfirm={() => { const list = pendingBatchDelete; setPendingBatchDelete(null); batchDelete(list) }}
          onCancel={() => setPendingBatchDelete(null)}
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
