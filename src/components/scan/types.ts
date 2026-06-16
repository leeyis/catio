import type { ScanMode, ScanFound, ScanProgress } from '../../services/scan'

// rowId 唯一键 = address（db 模式追加 '#'+engineId）
export interface ScanRow extends ScanFound {
  rowId: string
  selected: boolean
  existing: boolean
}

export interface ScanWizardProps {
  onClose: () => void
  onImported?: () => void
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
  onBack: () => void
  onStart: () => void
}

export interface StepScanningProps {
  progress: ScanProgress | null
  rows: ScanRow[]
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
