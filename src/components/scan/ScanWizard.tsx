// 自动扫描向导：全屏容器 + 状态机 + 事件接线 + 导入/导出逻辑。
// 顶部 4 步步骤条（mode/range/scanning/results），持有全部向导状态，
// 监听 scan:// 事件把 ScanFound 转为 ScanRow，并在结果页完成入库/导出。
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../Icon'
import { IconBtn } from '../atoms'
import {
  scanStart, scanCancel, onScanProgress, onScanFound, onScanDone, onScanLog,
  type ScanArgs, type ScanEngineProbe, type ScanFound, type ScanProgress,
  type ScanMode, type ScanKeySpec, type ScanLog,
} from '../../services/scan'
import type { DbType } from '../../services/db'
import { exportFile } from '../../services/db'
import { isTauri } from '../../services/ssh'
import { findEngine } from '../../services/dbEngines'
import { loadProfiles, saveProfile, type ConnectionProfile } from '../../state/connections'
import {
  listDbConnections, saveDbConnection, generateProfileId, type DbProfile,
} from '../../state/dbConnections'
import { setSessionSecret } from '../../state/sessionSecrets'
import { parseDict } from './parseDict'
import { toCsv, toJson } from './exportResults'
import type { ScanRow, ScanWizardProps } from './types'
import { StepMode } from './StepMode'
import { StepRangeCreds } from './StepRangeCreds'
import { StepScanning } from './StepScanning'
import StepResults from './StepResults'

const HOST_DEFAULT_PORT = 22
const DEFAULT_CONCURRENCY = 64

// ---- 文本解析工具 ----
// 字典解析复用 ./parseDict（按“第一个空白”切分，兼容含空格密码），与 spec/单测一致。

/** "8080, 9090\n6379" 之类的自定义端口文本 → 去重端口数组。 */
function parsePorts(text: string): number[] {
  const set = new Set<number>()
  for (const tok of text.split(/[\s,]+/)) {
    const n = Number(tok.trim())
    if (Number.isInteger(n) && n > 0 && n <= 65535) set.add(n)
  }
  return [...set]
}

/** "root, admin" → 去重用户名数组。 */
function parseUsers(text: string): string[] {
  const set = new Set<string>()
  for (const tok of text.split(/[\s,]+/)) {
    const u = tok.trim()
    if (u) set.add(u)
  }
  return [...set]
}

/** 换行/逗号分隔的 CIDR/区间文本 → 去重数组。 */
function parseRanges(text: string): string[] {
  const set = new Set<string>()
  for (const tok of text.split(/[\s,]+/)) {
    const r = tok.trim()
    if (r) set.add(r)
  }
  return [...set]
}

// ---- 导出工具 ----
// CSV/JSON 序列化复用 ./exportResults（统一剔除明文 hitSecret），与单测覆盖的实现一致。

function triggerBlobDownload(text: string, mime: string, filename: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ---- 行构造工具 ----

/** rowId 唯一键：host 用 address；db 追加 '#'+engineId。 */
function rowIdFor(f: ScanFound): string {
  return f.kind === 'db' && f.engineId ? `${f.address}#${f.engineId}` : f.address
}

/** ScanFound → ScanRow，计算去重(existing)与默认勾选(selected)。 */
function toRow(f: ScanFound, existingHosts: Set<string>, existingDbs: Set<string>): ScanRow {
  const hostPort = `${f.ip}:${f.port}`
  const existing = f.kind === 'host'
    ? existingHosts.has(hostPort)
    : existingDbs.has(`${hostPort}#${f.engineId ?? f.dbType ?? ''}`)
  // 默认勾选：✓已认证（命中凭证、首连免密）始终勾选；db 模式额外默认勾选 ⚠未授权
  // （识别到的库可入库为「需要认证」草稿，首连补密码）；host 模式后端只回传可登录节点，
  // 故 host 全是 authed。open（仅端口开放/未确认）与 existing 一律不默认勾选。
  const selected = !existing && (f.status === 'authed' || (f.kind === 'db' && f.status === 'unauthed'))
  return { ...f, rowId: rowIdFor(f), existing, selected }
}

// ---- 主组件 ----

export function ScanWizard({ onClose, onImported, existingHostKeys, existingDbKeys, onRememberSecret }: ScanWizardProps) {
  const { t } = useTranslation()

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [mode, setMode] = useState<ScanMode | null>(null)
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([])
  const [ranges, setRanges] = useState('')
  const [customPorts, setCustomPorts] = useState('')
  const [dictText, setDictText] = useState('')
  const [keyFiles, setKeyFiles] = useState<ScanKeySpec[]>([])
  const [keyUsersRaw, setKeyUsersRaw] = useState('')
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)

  const [scanId, setScanId] = useState<string | null>(null)
  const [rows, setRows] = useState<ScanRow[]>([])
  const [logs, setLogs] = useState<ScanLog[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanning, setScanning] = useState(false)
  const [done, setDone] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  // 结果页：入库目标分组（''=未分组）。
  const [groupId, setGroupId] = useState('')

  // 计时器与扫描状态的最新引用（供卸载清理用，避免闭包过期）。
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)
  const scanIdRef = useRef<string | null>(null)
  const scanningRef = useRef(false)
  scanIdRef.current = scanId
  scanningRef.current = scanning

  // 去重基线：优先用 App 传入的、与侧栏同源（按 ownsVault 作用域）的键，保证
  // “侧栏看到什么 = 去重比对什么”；缺省时回退到全局 loadProfiles/listDbConnections。
  const existingHosts = useMemo(() => {
    const keys = existingHostKeys ?? loadProfiles().map(p => `${p.host}:${p.port}`)
    return new Set(keys)
  }, [existingHostKeys])
  const existingDbs = useMemo(() => {
    const keys = existingDbKeys
      ?? listDbConnections().map(p => `${p.host}:${p.port}#${p.engineId ?? p.dbType}`)
    return new Set(keys)
  }, [existingDbKeys])

  // ---- 计算 defaultPorts ----
  const defaultPorts = useMemo<number[]>(() => {
    const set = new Set<number>()
    if (mode === 'host') {
      set.add(HOST_DEFAULT_PORT)
    } else if (mode === 'db') {
      for (const id of selectedEngineIds) {
        const eng = findEngine(id)
        if (eng && eng.defaultPort > 0) set.add(eng.defaultPort)
      }
    }
    for (const p of parsePorts(customPorts)) set.add(p)
    return [...set]
  }, [mode, selectedEngineIds, customPorts])

  // ---- 事件监听（整个向导生命周期内一次性接线）----
  useEffect(() => {
    let alive = true
    const unsubs: Array<() => void> = []
    Promise.all([
      onScanProgress(p => { if (alive) setProgress(p) }),
      onScanFound(f => {
        if (!alive) return
        const row = toRow(f, existingHosts, existingDbs)
        setRows(prev => (prev.some(r => r.rowId === row.rowId) ? prev : [...prev, row]))
      }),
      onScanLog(l => {
        if (!alive) return
        // 控制台式日志，封顶 1000 行，避免长扫描内存膨胀。
        setLogs(prev => (prev.length >= 1000 ? [...prev.slice(prev.length - 999), l] : [...prev, l]))
      }),
      onScanDone(() => {
        if (!alive) return
        setDone(true)
        setScanning(false)
        stopTimer()
      }),
    ]).then(fns => { if (alive) unsubs.push(...fns); else fns.forEach(f => f()) })
    return () => {
      alive = false
      unsubs.forEach(f => f())
    }
    // 监听只接线一次；去重基线为稳定快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 卸载（关闭向导）时：若仍在扫描则取消，并停止计时。
  useEffect(() => {
    return () => {
      stopTimer()
      if (scanningRef.current && scanIdRef.current) {
        scanCancel(scanIdRef.current).catch(() => { /* 忽略取消失败 */ })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  function startTimer() {
    stopTimer()
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)
  }

  // ---- 步骤①：模式/引擎选择 ----
  const handleModeChange = useCallback((m: ScanMode) => setMode(m), [])
  const handleToggleEngine = useCallback((id: string) => {
    setSelectedEngineIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }, [])

  // ---- 步骤②：上传处理 ----
  // 私钥文件：用 plugin-dialog 取路径（仅路径，首连用 keyFile 认证）。
  const handleAddKeyFiles = useCallback(async () => {
    if (!isTauri()) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: true, title: t('scan.keys.upload') })
      if (!picked) return
      const paths = Array.isArray(picked) ? picked : [picked]
      setKeyFiles(prev => {
        const seen = new Set(prev.map(k => k.path))
        const added: ScanKeySpec[] = []
        for (const p of paths) {
          if (typeof p !== 'string' || seen.has(p)) continue
          seen.add(p)
          added.push({ path: p, name: p.split(/[\\/]/).pop() || p })
        }
        return [...prev, ...added]
      })
    } catch { /* 用户取消或对话框不可用 */ }
  }, [t])

  const handleRemoveKeyFile = useCallback((path: string) => {
    setKeyFiles(prev => prev.filter(k => k.path !== path))
  }, [])

  // 注：字典凭据通过 StepRangeCreds 的 dictText 文本框直接编辑/粘贴
  // （StepRangeCredsProps 仅暴露 onDictTextChange，未提供文件上传回调）。
  // 本项目未集成 @tauri-apps/plugin-fs 的 JS 绑定，故不在此读取字典文件文本。

  // ---- 步骤②→③：开始扫描 ----
  const handleStart = useCallback(async () => {
    if (!mode) return
    const creds = parseDict(dictText)
    const rangeList = parseRanges(ranges)

    const args: ScanArgs = {
      mode,
      ranges: rangeList,
      creds,
      concurrency,
    }
    if (mode === 'host') {
      args.ports = defaultPorts
      if (keyFiles.length > 0) args.keys = keyFiles
      const keyUsers = parseUsers(keyUsersRaw)
      if (keyUsers.length > 0) args.keyUsers = keyUsers
    } else {
      // db：每个所选引擎一条 probe；自定义端口对同一引擎追加额外 probe。
      const extraPorts = parsePorts(customPorts)
      const probes: ScanEngineProbe[] = []
      for (const id of selectedEngineIds) {
        const eng = findEngine(id)
        if (!eng) continue
        const ports = new Set<number>()
        if (eng.defaultPort > 0) ports.add(eng.defaultPort)
        for (const p of extraPorts) ports.add(p)
        for (const port of ports) {
          probes.push({
            engineId: eng.id,
            dbType: eng.dbType,
            ...(eng.driverProfile ? { driverProfile: eng.driverProfile } : {}),
            port,
          })
        }
      }
      args.engines = probes
    }

    // 进入步骤③并立即开始计时（即便 scanStart 在途）。
    setRows([])
    setLogs([])
    setProgress(null)
    setDone(false)
    setScanning(true)
    setStep(3)
    startTimer()
    try {
      const id = await scanStart(args)
      setScanId(id)
    } catch (e) {
      // 启动失败（如非 Tauri）：停止扫描态，停在步骤③显示空结果。
      setScanning(false)
      setDone(true)
      stopTimer()
      console.error('scanStart 失败', e)
    }
  }, [mode, dictText, ranges, concurrency, defaultPorts, keyFiles, keyUsersRaw, customPorts, selectedEngineIds])

  // ---- 步骤③：取消 ----
  const handleCancel = useCallback(() => {
    setScanning(false)
    setDone(true)
    stopTimer()
    if (scanId) scanCancel(scanId).catch(() => { /* 忽略 */ })
  }, [scanId])

  // ---- 步骤④：勾选 ----
  const handleToggleRow = useCallback((rowId: string) => {
    setRows(prev => prev.map(r => (r.rowId === rowId ? { ...r, selected: !r.selected } : r)))
  }, [])
  const handleToggleAll = useCallback((selected: boolean, visibleRowIds: string[]) => {
    const set = new Set(visibleRowIds)
    // existing 行不可入库/勾选，全选时跳过，避免误入导出选中集。
    setRows(prev => prev.map(r => (set.has(r.rowId) && !r.existing ? { ...r, selected } : r)))
  }, [])

  // ---- 步骤④：导入入库 ----
  const handleImport = useCallback(() => {
    const picks = rows.filter(r => r.selected && !r.existing)
    if (picks.length === 0) return
    let imported = 0
    for (const r of picks) {
      if (r.kind === 'host') {
        const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? `host-${crypto.randomUUID()}`
          : `host-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const auth = r.hitAuthKind === 'key' && r.hitKeyPath
          ? { method: 'keyFile' as const, path: r.hitKeyPath }
          : { method: 'password' as const }
        const profile: ConnectionProfile = {
          id,
          name: r.address,
          host: r.ip,
          port: r.port,
          user: r.hitUser || '',
          auth,
          ...(groupId ? { group: groupId } : {}),
          // 侧栏品牌 logo 需要 OS 目录 id（ubuntu/centos…），而非展示名。
          ...(r.osId ? { os: r.osId } : {}),
        }
        try {
          saveProfile(profile)
          // authed 且 password 命中：缓存命中密码供首连免二次输入。
          // 会话内存（本次会话）+ 加密 vault（启用账户验证时持久化，重启后仍免密）。
          if (r.status === 'authed' && r.hitAuthKind === 'password' && r.hitSecret) {
            setSessionSecret(id, r.hitSecret)
            onRememberSecret?.(id, r.hitSecret)
          } else if (r.status === 'authed' && r.hitAuthKind === 'key') {
            // 私钥命中：扫描已验证该私钥可【免口令】登录，存空口令标记，
            // 首连直接用私钥连接、不再弹密码框。
            setSessionSecret(id, '')
          }
          imported++
        } catch { /* localStorage 不可用 */ }
      } else {
        const id = generateProfileId()
        const eng = r.engineId ? findEngine(r.engineId) : undefined
        const dbType = (eng?.dbType ?? (r.dbType as DbType | undefined) ?? 'postgres') as DbType
        const profile: DbProfile = {
          id,
          name: r.address,
          dbType,
          ...(eng?.id ? { engineId: eng.id } : (r.engineId ? { engineId: r.engineId } : {})),
          ...(eng?.driverProfile ?? r.driverProfile
            ? { driverProfile: eng?.driverProfile ?? r.driverProfile }
            : {}),
          host: r.ip,
          port: r.port,
          user: r.hitUser || '',
          ...(groupId ? { group: groupId } : {}),
          // 未命中凭证的库 → 草稿，标「需要认证」，首连由用户补密码。
          ...(r.status !== 'authed' ? { needsAuth: true } : {}),
        }
        try {
          saveDbConnection(profile) // 内部 notify()，db 列表自动刷新
          if (r.status === 'authed' && r.hitSecret) {
            setSessionSecret(id, r.hitSecret)
            onRememberSecret?.(id, r.hitSecret)
          }
          imported++
        } catch { /* localStorage 不可用 */ }
      }
    }
    // host saveProfile 不通知父级，需手动触发刷新。
    onImported?.()
    console.info(t('scan.toast.imported', { n: imported }))
    onClose()
  }, [rows, groupId, onImported, onRememberSecret, onClose, t])

  // ---- 步骤④：导出 ----
  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    const picks = rows.filter(r => r.selected)
    const text = format === 'csv' ? toCsv(picks) : toJson(picks)
    const mime = format === 'csv' ? 'text/csv' : 'application/json'
    const filename = `scan-export.${format}`
    if (!isTauri()) { triggerBlobDownload(text, mime, filename); return }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({
        defaultPath: filename,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      })
      if (path) await exportFile(path, text)
    } catch { /* 用户取消或写入失败 */ }
  }, [rows])

  // ---- 步骤条 ----
  const steps: Array<{ n: 1 | 2 | 3 | 4; key: string }> = [
    { n: 1, key: 'scan.step.mode' },
    { n: 2, key: 'scan.step.range' },
    { n: 3, key: 'scan.step.scanning' },
    { n: 4, key: 'scan.step.results' },
  ]

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--surface-card)', color: 'var(--text-primary)', overflow: 'hidden',
    }}>
      {/* 顶栏：标题 + 步骤条 + 关闭 */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '14px 24px',
        borderBottom: '1px solid var(--border-hairline)', flex: '0 0 auto',
        background: 'var(--surface-subtle)',
      }}>
        <div className="row gap10" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="icon-badge" style={{
            width: 30, height: 30, borderRadius: 9,
            color: 'var(--accent-primary)', background: 'var(--accent-soft)',
          }}>
            <Icon name="radar" size={17} />
          </span>
          <h1 style={{ margin: 0, fontSize: 15.5, fontWeight: 700, letterSpacing: '-0.2px' }}>
            {t('scan.title')}
          </h1>
        </div>
        <nav style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          {steps.map((s, i) => {
            const active = s.n === step
            const past = s.n < step
            return (
              <React.Fragment key={s.n}>
                {i > 0 && <Icon name="chevron-right" size={14} style={{ color: 'var(--text-faint)' }} />}
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 26, padding: '0 10px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  color: active ? 'var(--text-primary)' : past ? 'var(--text-tertiary)' : 'var(--text-faint)',
                  background: active ? 'var(--surface-card)' : 'transparent',
                  border: active ? '1px solid var(--border-hairline)' : '1px solid transparent',
                }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 16, height: 16, borderRadius: 8, fontSize: 10, fontWeight: 700,
                    color: active || past ? 'var(--on-accent)' : 'var(--text-faint)',
                    background: active || past ? 'var(--accent-primary)' : 'var(--surface-sunken)',
                  }}>{past ? <Icon name="check" size={10} /> : s.n}</span>
                  {t(s.key)}
                </span>
              </React.Fragment>
            )
          })}
        </nav>
        <div style={{ marginLeft: 'auto' }}>
          <IconBtn name="x" title={t('scan.close')} onClick={onClose} />
        </div>
      </header>

      {/* 步骤主体（居中内容列；风险提示在步骤②内呈现，避免重复）。
          步骤④：main 不滚动，由内层 flex 列把高度交给 StepResults——表格内部滚动、
          底部操作栏始终固定可见。 */}
      <main style={{
        flex: '1 1 auto', minHeight: 0,
        overflow: step === 4 ? 'hidden' : 'auto',
        padding: step === 4 ? '20px 24px 22px' : '28px 24px 40px',
      }}>
       <div style={{
         maxWidth: step === 4 ? 1120 : 880, margin: '0 auto', width: '100%',
         ...(step === 4 ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } : {}),
       }}>
        {step === 1 && (
          <StepMode
            mode={mode}
            onModeChange={handleModeChange}
            selectedEngineIds={selectedEngineIds}
            onToggleEngine={handleToggleEngine}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && mode && (
          <StepRangeCreds
            mode={mode}
            ranges={ranges}
            onRangesChange={setRanges}
            customPorts={customPorts}
            onCustomPortsChange={setCustomPorts}
            dictText={dictText}
            onDictTextChange={setDictText}
            keyFiles={keyFiles}
            onAddKeyFiles={handleAddKeyFiles}
            onRemoveKeyFile={handleRemoveKeyFile}
            keyUsersRaw={keyUsersRaw}
            onKeyUsersChange={setKeyUsersRaw}
            concurrency={concurrency}
            onConcurrencyChange={setConcurrency}
            defaultPorts={defaultPorts}
            onBack={() => setStep(1)}
            onStart={handleStart}
          />
        )}
        {step === 3 && (
          <StepScanning
            progress={progress}
            rows={rows}
            logs={logs}
            scanning={scanning}
            done={done}
            onCancel={handleCancel}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
            elapsedMs={elapsedMs}
          />
        )}
        {step === 4 && mode && (
          <StepResults
            rows={rows}
            mode={mode}
            groupId={groupId}
            onGroupChange={setGroupId}
            onToggleRow={handleToggleRow}
            onToggleAll={handleToggleAll}
            onImport={handleImport}
            onExport={handleExport}
            onBack={() => setStep(3)}
          />
        )}
       </div>
      </main>
    </div>
  )
}

export default ScanWizard
