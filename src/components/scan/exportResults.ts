import type { ScanRow } from './types'

// 导出结果：只导出传入的（已勾选）行。
// 这是凭证发现清单的产物，导出明文用户名/密码（命中的工作凭证），供运维留存自有资产。
// 注意：屏幕上的结果表仍对密码打码（••••），仅导出文件携带明文。

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

// 命中密码列：密码命中导出明文 hitSecret；私钥命中导出 🔑密钥名；未命中为空。
function secretCell(row: ScanRow): string {
  if (row.status !== 'authed') return ''
  if (row.hitAuthKind === 'key') return row.hitKeyName ? `🔑${row.hitKeyName}` : ''
  return row.hitSecret || ''
}

/**
 * 导出为 CSV，列=地址,引擎/OS,版本,命中用户,密码,认证方式,状态。
 * 「密码」列为命中的明文密码（私钥命中显示密钥名）。
 */
export function toCsv(rows: ScanRow[]): string {
  const header = ['地址', '引擎/OS', '版本', '命中用户', '密码', '认证方式', '状态']
  const lines = [header.map(csvEscape).join(',')]
  for (const row of rows) {
    const cells = [
      row.address,
      engineOrOs(row),
      row.version || '',
      row.hitUser || '',
      secretCell(row),
      row.hitAuthKind || '',
      row.status,
    ]
    lines.push(cells.map(c => csvEscape(c)).join(','))
  }
  return lines.join('\n')
}

/** 导出为 JSON，输出去除 UI 内部字段后的整洁对象（含明文密码 password）。 */
export function toJson(rows: ScanRow[]): string {
  const out = rows.map(r => ({
    address: r.address,
    ip: r.ip,
    port: r.port,
    kind: r.kind,
    ...(r.engineId ? { engineId: r.engineId } : {}),
    ...(r.dbType ? { dbType: r.dbType } : {}),
    ...(r.os ? { os: r.os } : {}),
    ...(r.version ? { version: r.version } : {}),
    status: r.status,
    ...(r.hitUser ? { user: r.hitUser } : {}),
    ...(r.hitSecret ? { password: r.hitSecret } : {}),
    ...(r.hitAuthKind ? { authKind: r.hitAuthKind } : {}),
    ...(r.hitKeyName ? { keyName: r.hitKeyName } : {}),
    ...(r.hitKeyPath ? { keyPath: r.hitKeyPath } : {}),
  }))
  return JSON.stringify(out, null, 2)
}
