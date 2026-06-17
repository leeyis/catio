import type { ScanCred } from '../../services/scan'

/**
 * 解析凭据字典文本：按行解析，每行按“第一个空白或冒号”切分（以先出现者为准）。
 * 首段为 user，其余整体为 password。文档推荐用空格分隔（密码可含空格/冒号），
 * 同时兼容 `user:password` 写法，避免格式不一致导致静默解析失败。
 * 忽略空行与无分隔符（仅用户名）的行；'#' 开头视为注释；user/password 两侧 trim。
 */
export function parseDict(text: string): ScanCred[] {
  const creds: ScanCred[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // 第一个空白或冒号作为分隔符（先出现者）；其余整体为密码。
    const sep = line.search(/[\s:]/)
    if (sep < 0) continue // 没有分隔符 → 仅用户名，忽略
    const user = line.slice(0, sep).trim()
    const password = line.slice(sep + 1).trim()
    if (!user || !password) continue
    creds.push({ user, password })
  }
  return creds
}
