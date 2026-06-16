import type { ScanCred } from '../../services/scan'

/**
 * 解析凭据字典文本：按行解析，每行按“第一个空白”切分。
 * 首段为 user，其余整体为 password（兼容含空格的密码）。
 * 忽略空行与无密码（仅用户名）的行；user/password 两侧 trim。
 */
export function parseDict(text: string): ScanCred[] {
  const creds: ScanCred[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(/^(\S+)\s+(.+)$/)
    if (!m) continue // 仅用户名、无密码 → 忽略
    const user = m[1].trim()
    const password = m[2].trim()
    if (!user || !password) continue
    creds.push({ user, password })
  }
  return creds
}
