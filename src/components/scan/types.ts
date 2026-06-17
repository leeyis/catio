import type { ScanMode, ScanFound, ScanProgress, ScanLog } from '../../services/scan'

// rowId 唯一键 = address（db 模式追加 '#'+engineId）
export interface ScanRow extends ScanFound {
  rowId: string
  selected: boolean
  existing: boolean
}

export interface ScanWizardProps {
  onClose: () => void
  onImported?: () => void
  /** 去重基线：与侧栏同源（App 按 ownsVault 作用域计算）的现有 host 键 `host:port`。
   *  缺省时回退到全局 loadProfiles()（仅用于无 App 上下文的测试场景）。 */
  existingHostKeys?: string[]
  /** 去重基线：现有 db 键 `host:port#engineId|dbType`，同样与侧栏同源。 */
  existingDbKeys?: string[]
  /** 入库 ✓已认证连接时，把命中密码持久化到加密 vault（启用账户验证且已解锁时生效），
   *  使首连免密在重启/重新登录后依然有效。由 App 注入（rememberConnSecret）。 */
  onRememberSecret?: (profileId: string, secret: string) => void
}

export interface StepModeProps {
  mode: ScanMode | null
  onModeChange: (m: ScanMode) => void
  selectedEngineIds: string[]
  onToggleEngine: (id: string) => void
  onNext: () => void
}

export interface StepRangeCredsProps {
  mode: ScanMode
  ranges: string
  onRangesChange: (v: string) => void
  customPorts: string
  onCustomPortsChange: (v: string) => void
  dictText: string
  onDictTextChange: (v: string) => void
  keyFiles: import('../../services/scan').ScanKeySpec[]
  onAddKeyFiles: () => void
  onRemoveKeyFile: (path: string) => void
  keyUsersRaw: string
  onKeyUsersChange: (v: string) => void
  concurrency: number
  onConcurrencyChange: (n: number) => void
  defaultPorts: number[]
  /** 必填项是否齐备（扫描范围 + 至少一组凭证或密钥）；否则禁用「开始扫描」。 */
  canStart: boolean
  onBack: () => void
  onStart: () => void
}

export interface StepScanningProps {
  progress: ScanProgress | null
  rows: ScanRow[]
  logs: ScanLog[]
  scanning: boolean
  done: boolean
  onCancel: () => void
  onBack: () => void
  onNext: () => void
  elapsedMs: number
}

export interface StepResultsProps {
  rows: ScanRow[]
  mode: ScanMode
  /** 入库目标分组 id（''=未分组）；由 ScanWizard 持有并在导入时写入 profile.group。 */
  groupId: string
  onGroupChange: (id: string) => void
  onToggleRow: (rowId: string) => void
  onToggleAll: (selected: boolean, visibleRowIds: string[]) => void
  onImport: () => void
  onExport: (format: 'csv' | 'json') => void
  onBack: () => void
}
