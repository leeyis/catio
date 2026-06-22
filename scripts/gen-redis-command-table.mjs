// Generate src/components/dbviews/redisCommands.generated.ts from the official
// Redis commands.json. Run: `node scripts/gen-redis-command-table.mjs`
//
// Produces a rich command table (370 commands incl. subcommands) with arity,
// group, summary, one-line parameter signature, complexity, since version and a
// safety class aligned to the backend redis_command.rs. Re-run when bumping the
// supported Redis version. Requires Node 18+ (global fetch).
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC_URL = 'https://raw.githubusercontent.com/redis/redis-doc/master/commands.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'dbviews', 'redisCommands.generated.ts')

// Safety alignment with the backend (redis_command.rs classify_command): the
// FIRST token of these container/admin commands is rejected by the console.
const BLOCKED = new Set([
  'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'CONFIG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF',
  'SLAVEOF', 'REPLICAOF', 'MIGRATE', 'MODULE', 'SCRIPT', 'EVAL', 'EVALSHA',
  'DEBUG', 'MONITOR', 'SWAPDB', 'FAILOVER', 'CLUSTER', 'ACL',
])

// ---- arguments tree → one-line syntax signature (redis.io style) ----
function renderArg(a) {
  let core
  if (a.type === 'pure-token') {
    core = a.token ?? a.name ?? ''
  } else if (a.type === 'oneof') {
    core = (a.arguments ?? []).map(renderArg).join(' | ')
  } else if (a.type === 'block') {
    const inner = (a.arguments ?? []).map(renderArg).join(' ')
    core = a.token ? `${a.token} ${inner}` : inner
  } else {
    const label = a.display_text ?? a.name ?? a.type
    core = a.token ? `${a.token} ${label}` : label
  }
  if (a.multiple) {
    core = a.multiple_token && a.token ? `${core} [${a.token} ${a.display_text ?? a.name} ...]` : `${core} [${core} ...]`
  }
  if (a.optional) core = `[${core}]`
  return core
}

const buildSyntax = spec => (spec.arguments ?? []).map(renderArg).join(' ').replace(/\s+/g, ' ').trim()

function firstKeyInfo(spec) {
  const first = (spec.arguments ?? [])[0]
  const takesKey = !!first && first.type === 'key'
  return { takesKey, multiKey: takesKey && !!first.multiple }
}

function safetyOf(name, spec) {
  if (BLOCKED.has(name.split(' ')[0])) return 'blocked'
  if ((spec.acl_categories ?? []).includes('@write')) return 'confirm'
  return 'allowed'
}

const cmds = await (await fetch(SRC_URL)).json()

const out = {}
for (const [name, spec] of Object.entries(cmds)) {
  if (typeof spec.arity !== 'number') continue
  const { takesKey, multiKey } = firstKeyInfo(spec)
  const parts = name.split(' ')
  const entry = {
    arity: spec.arity,
    group: spec.group ?? 'generic',
    summary: (spec.summary ?? '').trim(),
    safety: safetyOf(name, spec),
    takesKey,
    multiKey,
  }
  if (spec.complexity) entry.complexity = spec.complexity.trim()
  if (spec.since) entry.since = spec.since
  const syntax = buildSyntax(spec)
  if (syntax) entry.syntax = syntax
  if (parts.length === 2) { entry.container = parts[0]; entry.sub = parts[1] }
  out[name] = entry
}

const keys = Object.keys(out).sort((a, b) => {
  const am = a.includes(' '), bm = b.includes(' ')
  if (am !== bm) return am ? 1 : -1
  return a < b ? -1 : a > b ? 1 : 0
})

const L = []
L.push('/* AUTO-GENERATED from Redis official commands.json by scripts/gen-redis-command-table.mjs — do not edit by hand. */')
L.push("export type RedisSafety = 'allowed' | 'confirm' | 'blocked'")
L.push('export interface RedisCommandDoc {')
L.push('  /** Token count incl. command name. >0 exact, <0 minimum (-N). */')
L.push('  arity: number')
L.push('  group: string')
L.push('  summary: string')
L.push('  safety: RedisSafety')
L.push('  /** First argument is a key name. */')
L.push('  takesKey: boolean')
L.push('  /** First key arg is variadic (keep suggesting keys past slot 0). */')
L.push('  multiKey: boolean')
L.push('  complexity?: string')
L.push('  since?: string')
L.push('  /** One-line argument signature (no command name). */')
L.push('  syntax?: string')
L.push('  /** For subcommands: the container command (e.g. "CONFIG"). */')
L.push('  container?: string')
L.push('  sub?: string')
L.push('}')
L.push('')
L.push('export const REDIS_COMMANDS: Record<string, RedisCommandDoc> = {')
for (const k of keys) L.push(`  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`)
L.push('}')
L.push('')

writeFileSync(OUT, L.join('\n'))
console.log(`wrote ${keys.length} commands to ${OUT}`)
