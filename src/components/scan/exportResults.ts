import type { ScanRow } from './types'

// 导出结果：只导出传入的（已勾选）行；一律剔除明文 hitSecret，命中密码打码。

function csvEscape(v: string): string {
  // 含逗号/引号/换行时用双引号包裹，内部引号翻倍。
  if (/[",\r\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"'
  }
  return v
}

// 引擎/OS 列：db 行取 engineId/dbType，host 行取 os。
function engineOrOs(row: ScanRow): string {
  if (row.kind === 'db') return row.engineId || row.dbType || ''
  return row.os || ''
}

/**
 * 导出为 CSV，列=地址,引擎/OS,版本,命中用户,状态。
 * 命中密码打码：不导出明文 hitSecret（CSV 中不含密码列，仅保留命中用户）。
 */
export function toCsv(rows: ScanRow[]): string {
  const header = ['地址', '引擎/OS', '版本', '命中用户', '状态']
  const lines = [header.map(csvEscape).join(',')]
  for (const row of rows) {
    const cells = [
      row.address,
      engineOrOs(row),
      row.version || '',
      row.hitUser || '',
      row.status,
    ]
    lines.push(cells.map(c => csvEscape(c)).join(','))
  }
  return lines.join('\n')
}

/** 导出为 JSON，剔除 hitSecret 明文。 */
export function toJson(rows: ScanRow[]): string {
  const safe = rows.map(({ hitSecret: _hitSecret, ...rest }) => rest)
  return JSON.stringify(safe, null, 2)
}
