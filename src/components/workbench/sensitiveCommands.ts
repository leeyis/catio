// 敏感/破坏性命令模式库 —— 广播确认网关的强警告依据。
// 纯函数、无任何 import。对命令做大小写不敏感、容忍多空格的正则匹配，
// 命中即把对应 RiskCode 收进 reasons（去重）。

/** 风险类别枚举：每个值对应一类破坏性命令模式。 */
export type RiskCode =
  | 'rmrf'
  | 'diskWrite'
  | 'power'
  | 'kill'
  | 'chmodR'
  | 'forkbomb'
  | 'overwrite'
  | 'dbDrop'

/** 检测结果：是否敏感 + 命中的风险类别列表（去重）。 */
export interface SensitivityResult {
  sensitive: boolean
  reasons: RiskCode[]
}

// 每条 [RiskCode, 正则] —— 正则均带 i 标志（大小写不敏感）。
// 注意：模式中以 \s+ / \s* 容忍多空格；以多种写法覆盖参数顺序差异。
const RISK_PATTERNS: ReadonlyArray<readonly [RiskCode, RegExp]> = [
  // rm -rf / rm -fr / rm 任意顺序含 -r 与 -f（合并短选项或分开写均命中）
  [
    'rmrf',
    // 合并短选项：-rf、-fr、-Rf 等；或分开的 -r ... -f / -f ... -r（含长选项）
    /\brm\b[^\n;|&]*?(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|(?:-{1,2}r(?:ecursive)?\b|-[a-z]*r[a-z]*)[^\n;|&]*?(?:-{1,2}f(?:orce)?\b|-[a-z]*f[a-z]*)|(?:-{1,2}f(?:orce)?\b|-[a-z]*f[a-z]*)[^\n;|&]*?(?:-{1,2}r(?:ecursive)?\b|-[a-z]*r[a-z]*))/i,
  ],

  // 磁盘/裸设备写入：dd（裸用即命中，对齐 spec 4.4）、mkfs.*、写裸设备（> /dev/sd* 或 of=/dev/...）
  [
    'diskWrite',
    /(?:\bdd\b(?:\s|$)|\bmkfs(?:\.[a-z0-9]+)?\b|>\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)|\bof=\s*\/dev\/)/i,
  ],

  // 关机/重启：shutdown / reboot / poweroff / halt / init 0 / init 6
  [
    'power',
    /\b(?:shutdown|reboot|poweroff|halt|init\s+[06])\b/i,
  ],

  // 强杀进程：kill -9 / pkill -9 / killall
  [
    'kill',
    /\b(?:p?kill\s+(?:-[a-z]*\s+)*-9\b|p?kill\s+(?:-[a-z]*\s+)*-s(?:ig)?(?:kill)?\b|killall\b)/i,
  ],

  // 递归权限/属主变更：chmod -R / chown -R
  [
    'chmodR',
    /\b(?:chmod|chown|chgrp)\b[^\n;|&]*?(?:-[a-z]*r[a-z]*\b|-{2}recursive\b)/i,
  ],

  // fork bomb：:(){ :|:& };: 形态（容忍空格）
  [
    'forkbomb',
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  ],

  // 覆盖/清空：> /etc/... 等关键路径、mv ... /（移入根目录覆盖）、单 > 清空任意文件（对齐 spec 4.4）
  [
    'overwrite',
    /(?:>\s*(?:\/etc\/|\/boot\/|~\/\.ssh\/|\$HOME\/\.ssh\/|\/root\/|\/(?:usr\/)?s?bin\/|\/var\/(?:lib|spool)\/)|\bmv\b[^\n;|&]*\s+\/\s*(?:$|[;|&])|(?<![>&\d])>(?![>&])\s*[^\s>;|&][^\n;|&]*)/i,
  ],

  // 数据库破坏：drop database / drop table / truncate table
  [
    'dbDrop',
    /\b(?:drop\s+(?:database|schema|table)|truncate\s+(?:table\s+)?)\b/i,
  ],
]

/**
 * 检测命令是否命中破坏性模式。
 * @param cmd 待检测的原始命令字符串
 * @returns { sensitive, reasons } —— reasons 已去重；sensitive = reasons.length > 0
 */
export function isSensitiveCommand(cmd: string): SensitivityResult {
  const reasons: RiskCode[] = []
  if (typeof cmd === 'string' && cmd.length > 0) {
    for (const [code, re] of RISK_PATTERNS) {
      if (re.test(cmd) && !reasons.includes(code)) {
        reasons.push(code)
      }
    }
  }
  return { sensitive: reasons.length > 0, reasons }
}
