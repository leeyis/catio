/* Redis 数据类型原生编辑:把一次编辑动作翻译成命令 argv(纯函数,便于单测)。
   语义与后端 redis_command.rs::build_edit_argv 一一对应(HSET/HDEL/RPUSH/LSET/
   SADD/SREM/ZADD score member/ZREM/SET/DEL/EXPIRE|PERSIST),参考 dbx 字段操作。 */

/** 一次 KV 编辑动作。前端按 key 类型发起。 */
export type RedisEdit =
  | { kind: 'setString'; key: string; value: string }
  | { kind: 'hashSet'; key: string; field: string; value: string }
  | { kind: 'hashDel'; key: string; field: string }
  | { kind: 'listPush'; key: string; value: string }
  | { kind: 'listSet'; key: string; index: number; value: string }
  | { kind: 'setAdd'; key: string; member: string }
  | { kind: 'setRem'; key: string; member: string }
  | { kind: 'zadd'; key: string; member: string; score: number }
  | { kind: 'zrem'; key: string; member: string }
  | { kind: 'delKey'; key: string }
  | { kind: 'setTtl'; key: string; ttl: number }

/** zset score 字面量:JS 的 String(number) 对整数(含 3.0 这类整值浮点)天然省略
 *  小数点(→ "3"),小数保留(1.5 → "1.5"),正是 Redis 期望的最短格式,无需特判。
 *  与后端 redis_command.rs::format_score 语义一致。 */
function formatScore(score: number): string {
  return String(score)
}

/**
 * 把一次编辑动作翻译成 Redis 命令 argv。key 不可为空(空 key 无意义且会误操作)。
 * 与后端 build_edit_argv 保持一致,既用于 UI 预览也保证前后端命令语义同源。
 */
export function buildRedisEditArgs(edit: RedisEdit): string[] {
  if (!edit.key) throw new Error('Redis 编辑操作的 key 不能为空')
  switch (edit.kind) {
    case 'setString': return ['SET', edit.key, edit.value]
    case 'hashSet': return ['HSET', edit.key, edit.field, edit.value]
    case 'hashDel': return ['HDEL', edit.key, edit.field]
    case 'listPush': return ['RPUSH', edit.key, edit.value]
    case 'listSet': return ['LSET', edit.key, String(edit.index), edit.value]
    case 'setAdd': return ['SADD', edit.key, edit.member]
    case 'setRem': return ['SREM', edit.key, edit.member]
    // dbx 语义:ZADD key score member(score 在前)。
    case 'zadd': return ['ZADD', edit.key, formatScore(edit.score), edit.member]
    case 'zrem': return ['ZREM', edit.key, edit.member]
    case 'delKey': return ['DEL', edit.key]
    // dbx set_ttl:正值 EXPIRE,非正值 PERSIST(去掉过期)。
    case 'setTtl': return edit.ttl > 0 ? ['EXPIRE', edit.key, String(edit.ttl)] : ['PERSIST', edit.key]
  }
}
