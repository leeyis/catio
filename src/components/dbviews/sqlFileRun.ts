/**
 * SQL 文件批量执行的前端纯逻辑：把后端推送的进度事件 (SqlFileProgress) 折叠成 UI 用的
 * 累积状态，并判定终态 / 是否可关闭。
 *
 * 后端（src-tauri/src/db/sql_file.rs + commands.rs db_run_sql_file）按方言切分语句，逐句执行，
 * 每次开始/完成/失败 + 整体完成/出错/取消都 emit `db://sql-file-progress`。本模块只做对话框的
 * 可测约束，不触碰真实 I/O（执行与切分均在 Rust 端，已单测）。
 */

/** 与后端 SqlFileStatus（camelCase 序列化）一致。 */
export type SqlFileStatus =
  | 'started'
  | 'running'
  | 'statementDone'
  | 'statementFailed'
  | 'done'
  | 'error'
  | 'cancelled'

/** 与后端 SqlFileProgress 一致。 */
export interface SqlFileProgress {
  executionId: string
  status: SqlFileStatus
  statementIndex: number
  total: number
  successCount: number
  failureCount: number
  affectedRows: number
  elapsedMs: number
  statementSummary: string
  error: string | null
}

/** UI 累积状态：进度条 + 计数 + 最近一条语句 + 失败明细 + 是否终态。 */
export interface SqlFileRunState {
  status: SqlFileStatus
  statementIndex: number
  total: number
  successCount: number
  failureCount: number
  affectedRows: number
  elapsedMs: number
  currentStatement: string
  /** 失败的语句明细（continue_on_error 下可累积多条）。 */
  errors: { statementIndex: number; summary: string; message: string }[]
}

/** 初始（尚未收到任何事件）的执行状态。 */
export function initialRunState(): SqlFileRunState {
  return {
    status: 'started',
    statementIndex: 0,
    total: 0,
    successCount: 0,
    failureCount: 0,
    affectedRows: 0,
    elapsedMs: 0,
    currentStatement: '',
    errors: [],
  }
}

/** 是否为终态（done/error/cancelled）——决定是否停止监听、允许关闭对话框。 */
export function isTerminalStatus(status: SqlFileStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * 把一条进度事件折叠进累积状态（纯函数，返回新对象）。
 * - 计数 / 进度 / 耗时一律采用事件里的最新值（后端已累积）。
 * - statementFailed 追加一条失败明细（带语句序号与摘要）。
 * - running 时更新「当前语句」展示；终态不覆盖。
 */
export function reduceProgress(state: SqlFileRunState, ev: SqlFileProgress): SqlFileRunState {
  const next: SqlFileRunState = {
    ...state,
    status: ev.status,
    statementIndex: ev.statementIndex,
    total: ev.total,
    successCount: ev.successCount,
    failureCount: ev.failureCount,
    affectedRows: ev.affectedRows,
    elapsedMs: ev.elapsedMs,
    errors: state.errors,
  }
  if (ev.status === 'running' && ev.statementSummary) {
    next.currentStatement = ev.statementSummary
  }
  if (ev.status === 'statementFailed' && ev.error) {
    next.errors = [
      ...state.errors,
      { statementIndex: ev.statementIndex, summary: ev.statementSummary, message: ev.error },
    ]
  }
  return next
}

/** 进度百分比 [0,100]（total 为 0 时返回 0，避免除零）。 */
export function progressPercent(state: SqlFileRunState): number {
  if (state.total <= 0) return 0
  const pct = Math.round((state.statementIndex / state.total) * 100)
  return Math.min(100, Math.max(0, pct))
}
