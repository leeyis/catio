/**
 * Lightweight Redis command autocompletion for the plain-mode query editor.
 * Modeled on dbx's redisCompletion.ts (apps/desktop/src/lib) but trimmed to what
 * catio's console needs: command-name completion + key-name completion (no arity
 * diagnostics, no subcommands). Blocked/admin commands are intentionally omitted
 * so the menu only offers things that actually run (mirrors redis_command.rs).
 *
 * The core is a pure planner over the text-before-cursor so it unit-tests without
 * a CodeMirror state; `redisCompletion()` wraps it as a CompletionSource — same
 * shape as `mongoCompletion()`.
 */
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'

export interface RedisOption {
  label: string
  apply?: string
  detail?: string
  type?: string
}

export interface RedisPlan {
  /** Number of chars before the cursor that the inserted text replaces. */
  replaceLen: number
  options: RedisOption[]
}

interface CmdMeta { name: string; group: string }

// Command set, grouped. Blocked/admin commands (FLUSHALL/CONFIG/EVAL/SHUTDOWN/…)
// are deliberately absent — they're rejected by the backend. KEYS is kept (it
// runs) but users are nudged toward SCAN by the prompt/placeholder.
const COMMANDS: CmdMeta[] = [
  // string
  ...['GET', 'SET', 'SETEX', 'SETNX', 'GETSET', 'GETDEL', 'GETRANGE', 'SETRANGE', 'APPEND', 'STRLEN', 'MGET', 'MSET', 'MSETNX', 'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY'].map(name => ({ name, group: 'string' })),
  // generic key
  ...['DEL', 'UNLINK', 'EXISTS', 'EXPIRE', 'EXPIREAT', 'PEXPIRE', 'PERSIST', 'TTL', 'PTTL', 'TYPE', 'RENAME', 'RENAMENX', 'COPY', 'MOVE', 'TOUCH', 'DUMP', 'RESTORE', 'SCAN', 'KEYS', 'RANDOMKEY', 'SORT'].map(name => ({ name, group: 'generic' })),
  // list
  ...['LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LINDEX', 'LSET', 'LINSERT', 'LREM', 'LTRIM', 'LMOVE', 'RPOPLPUSH', 'LPOS'].map(name => ({ name, group: 'list' })),
  // hash
  ...['HSET', 'HSETNX', 'HGET', 'HMGET', 'HGETALL', 'HDEL', 'HEXISTS', 'HKEYS', 'HVALS', 'HLEN', 'HINCRBY', 'HINCRBYFLOAT', 'HSTRLEN', 'HSCAN', 'HRANDFIELD'].map(name => ({ name, group: 'hash' })),
  // set
  ...['SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SPOP', 'SRANDMEMBER', 'SMOVE', 'SSCAN', 'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD'].map(name => ({ name, group: 'set' })),
  // zset
  ...['ZADD', 'ZREM', 'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZINCRBY', 'ZRANK', 'ZREVRANK', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZSCAN'].map(name => ({ name, group: 'zset' })),
  // stream
  ...['XADD', 'XLEN', 'XRANGE', 'XREVRANGE', 'XREAD', 'XDEL', 'XTRIM', 'XINFO'].map(name => ({ name, group: 'stream' })),
  // bitmap / hll / geo
  ...['SETBIT', 'GETBIT', 'BITCOUNT', 'BITPOS'].map(name => ({ name, group: 'bitmap' })),
  ...['PFADD', 'PFCOUNT', 'PFMERGE'].map(name => ({ name, group: 'hyperloglog' })),
  ...['GEOADD', 'GEODIST', 'GEOPOS', 'GEOSEARCH'].map(name => ({ name, group: 'geo' })),
  // server / connection (no key argument)
  ...['DBSIZE', 'INFO', 'TIME', 'COMMAND', 'LASTSAVE'].map(name => ({ name, group: 'server' })),
  ...['PING', 'ECHO', 'SELECT'].map(name => ({ name, group: 'connection' })),
]

const CMD_BY_NAME = new Map(COMMANDS.map(c => [c.name, c]))

// Groups whose first argument is a key name → enable key completion there.
const KEY_GROUPS = new Set(['string', 'generic', 'list', 'hash', 'set', 'zset', 'stream', 'bitmap', 'hyperloglog', 'geo'])
// Commands taking a variadic list of keys — keep suggesting keys past the first slot.
const MULTI_KEY = new Set(['DEL', 'UNLINK', 'EXISTS', 'TOUCH', 'MGET', 'PFCOUNT', 'PFMERGE', 'SINTER', 'SUNION', 'SDIFF'])

function commandOptions(prefix: string): RedisOption[] {
  const p = prefix.toLowerCase()
  return COMMANDS
    .filter(c => !p || c.name.toLowerCase().startsWith(p))
    // Trailing space so the user flows straight into the first argument.
    .map(c => ({ label: c.name, apply: `${c.name} `, detail: c.group, type: 'keyword' }))
}

function keyOptions(prefix: string, keys: string[]): RedisOption[] {
  const p = prefix.toLowerCase()
  const matched = p ? keys.filter(k => k.toLowerCase().includes(p)) : keys
  return matched.slice(0, 100).map(k => ({ label: k, apply: k, detail: 'key', type: 'variable' }))
}

/**
 * Plan a completion from the text before the cursor on the current line.
 * Returns null when no candidate applies.
 */
export function redisCompletionPlan(before: string, keys: string[]): RedisPlan | null {
  const endsWithSpace = before.length > 0 && /\s$/.test(before)
  const tokens = before.trim().length === 0 ? [] : before.trim().split(/\s+/)
  const currentWord = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '')
  const typed = endsWithSpace ? tokens : tokens.slice(0, -1)

  // Command position — first token of the line.
  if (typed.length === 0) {
    const opts = commandOptions(currentWord)
    return opts.length ? { replaceLen: currentWord.length, options: opts } : null
  }

  // Argument position — offer key names when the command's first arg is a key.
  const main = typed[0].toUpperCase()
  const meta = CMD_BY_NAME.get(main)
  if (!meta || !KEY_GROUPS.has(meta.group)) return null
  const argIndex = typed.length - 1 // 0-based, after the command token
  const suggestKey = MULTI_KEY.has(main) || argIndex === 0
  if (!suggestKey) return null
  const opts = keyOptions(currentWord, keys)
  return opts.length ? { replaceLen: currentWord.length, options: opts } : null
}

/**
 * Build a CodeMirror CompletionSource. `getKeys` is read lazily so the source
 * identity stays stable while the live key sample updates.
 */
export function redisCompletion(getKeys: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const plan = redisCompletionPlan(before, getKeys())
    if (!plan) return null
    return {
      from: context.pos - plan.replaceLen,
      options: plan.options.map(o => ({ label: o.label, apply: o.apply, detail: o.detail, type: o.type } as Completion)),
      validFor: /[\w:*.\-]*$/,
    }
  }
}
