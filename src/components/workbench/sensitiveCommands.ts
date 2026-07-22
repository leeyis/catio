// 敏感/破坏性命令模式库 —— 广播确认网关的强警告依据。
// 纯函数、无任何 import。对命令做大小写不敏感、容忍多空格的正则匹配，
// 命中即把对应 RiskCode 收进 reasons（去重）。

/** 风险类别枚举：每个值对应一类破坏性命令模式。 */
export type RiskCode =
  | 'fileDelete'
  | 'fileMove'
  | 'diskWrite'
  | 'power'
  | 'kill'
  | 'service'
  | 'chmodR'
  | 'forkbomb'
  | 'overwrite'
  | 'dbDrop'
  | 'infra'
  | 'gitDestructive'
  | 'secretAccess'

/** 检测结果：是否敏感 + 命中的风险类别列表（去重）。 */
export interface SensitivityResult {
  sensitive: boolean
  reasons: RiskCode[]
}

// 每条 [RiskCode, 正则] —— 正则均带 i 标志（大小写不敏感）。
// 注意：模式中以 \s+ / \s* 容忍多空格；以多种写法覆盖参数顺序差异。
const RISK_PATTERNS: ReadonlyArray<readonly [RiskCode, RegExp]> = [
  // 文件删除与移动：即使目标看似局部，也可能因路径或变量展开而越界。
  [
    'fileDelete',
    /\b(?:rm|rmdir|unlink|del|erase|remove-item)\b/i,
  ],
  [
    'fileMove',
    /\b(?:mv|move|move-item)\b/i,
  ],

  // 磁盘/裸设备写入：dd（裸用即命中，对齐 spec 4.4）、mkfs.*、写裸设备（> /dev/sd* 或 of=/dev/...）
  [
    'diskWrite',
    /(?:\bdd\b(?:\s|$)|\bmkfs(?:\.[a-z0-9]+)?\b|>\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk|disk)|\bof=\s*\/dev\/)/i,
  ],

  // 关机/重启：Unix 与 PowerShell 常见写法。
  [
    'power',
    /\b(?:shutdown|reboot|poweroff|halt|init\s+[06]|restart-computer|stop-computer)\b/i,
  ],

  // 结束进程：无论信号强度都可能中断服务或造成数据丢失。
  [
    'kill',
    /\b(?:kill|pkill|killall|taskkill|stop-process)\b/i,
  ],

  // 服务与容器生命周期变更。
  [
    'service',
    /(?:\b(?:systemctl|service)\b[^\n;|&]*\b(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)\b|\b(?:start|stop|restart)-service\b|(?:^|[;&|]\s*|\b(?:sudo|doas)\s+)restart\b|\bsc(?:\.exe)?\s+(?:start|stop|config|delete)\b|\b(?:docker|podman)\s+(?:rm|stop|kill|restart)\b|\bdocker\s+compose\s+(?:down|restart|stop|kill|rm)\b|\bnvidia-smi\b[^\n;|&]*--gpu-reset\b)/i,
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

  // 覆盖关键系统文件；普通工作区文件写入不在半自动拦截范围内。
  [
    'overwrite',
    /(?:(?:>|>>|\btee\b|\bsed\s+-i\b|\bperl\s+-pi\b|\binstall\b|\bcp\b|\bcopy\b|\bset-content\b|\badd-content\b|\bout-file\b)[^\n;&]*(?:\/etc\/|\/boot\/|\/root\/|\/(?:usr\/)?s?bin\/|\/var\/(?:lib|spool)\/|[a-z]:\\windows\\(?:system32|syswow64)\\))/i,
  ],

  // 数据库破坏：drop database / drop table / truncate table
  [
    'dbDrop',
    /\b(?:drop\s+(?:database|schema|table)|truncate\s+(?:table\s+)?)\b/i,
  ],

  // 基础设施变更：编排器、IaC 与清理命令通常影响多个资源。
  [
    'infra',
    /(?:\bkubectl\s+(?:apply|replace|patch|delete|drain|cordon|uncordon|taint|scale)\b|\bkubectl\s+rollout\s+restart\b|\bterraform\s+(?:apply|destroy)\b|\b(?:docker|podman)\s+(?:system|volume|network|image)\s+prune\b)/i,
  ],

  // Git 中会丢弃本地工作或强制改写远端历史的操作。
  [
    'gitDestructive',
    /(?:\bgit\s+reset\b[^\n;|&]*--hard\b|\bgit\s+clean\b|\bgit\s+branch\b[^\n;|&]*-D\b|\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?\b|-f\b)|\bgit\s+(?:checkout\s+--|restore\b))/i,
  ],

  // 凭据目录、集群 Secret 与完整环境变量转储会进入 Agent 上下文。
  [
    'secretAccess',
    /(?:(?:^|[\\/])\.(?:ssh|aws|kube)(?:[\\/]|$)|\bkubectl\b[^\n;|&]*\b(?:get|describe)\s+secrets?\b|^\s*(?:env|printenv|set)\s*$|\bget-childitem\s+env:\s*$)/i,
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
