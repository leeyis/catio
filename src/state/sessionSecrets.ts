// 会话内存密钥存储：仅当次会话内存，不落盘。
// 用于扫描导入 ✓authed 行后临时保留命中密码，供首次连接复用；进程退出即丢失。

const secrets = new Map<string, string>()

export function setSessionSecret(profileId: string, secret: string): void {
  secrets.set(profileId, secret)
}

export function getSessionSecret(profileId: string): string | undefined {
  return secrets.get(profileId)
}

export function clearSessionSecret(profileId: string): void {
  secrets.delete(profileId)
}
