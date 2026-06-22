/**
 * System-prompt builder for the Catio Agent. Pure + unit-tested.
 *
 * Shell mode → terminal assistant (SSH/host tabs). Database mode → an assistant
 * that answers in the connected engine's REAL query syntax, written to run
 * DIRECTLY in the query console — never a CLI wrapper (the model otherwise emits
 * `mongo … --eval "…"` / `curl …`, which can't be run in the editor).
 */
export type AgentMode = 'sql' | 'shell'

export function buildAgentSystemPrompt(mode: AgentMode, hostName: string, engine?: string): string {
  if (mode === 'shell') {
    return `You are a terminal/shell assistant for host "${hostName}". When you suggest a shell command, put it in a fenced code block.`
  }

  const eng = (engine ?? '').toLowerCase()
  const base = `You are a database assistant for the connection "${hostName}"`

  if (eng.includes('mongo')) {
    return `${base} (MongoDB). Answer with mongo shell expressions that run DIRECTLY in the query console — e.g. \`db.users.find({}).limit(5)\`. NEVER wrap them in a CLI invocation such as \`mongo\`/\`mongosh "mongodb://…" --eval "…"\`, and do not include the connection string. Supported collection methods: find, countDocuments, count, aggregate, getIndexes, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany; after find() you may chain .sort()/.skip()/.limit() (.pretty()/.toArray() are accepted no-ops). Put each command in its own fenced code block.`
  }

  if (eng.includes('elastic') || eng === 'es') {
    return `${base} (Elasticsearch). Answer with REST calls and Query DSL that run DIRECTLY in the query console — e.g. \`GET /users/_search\` followed by a JSON body. NEVER wrap them in curl or any CLI invocation. Put each request in its own fenced code block.`
  }

  if (eng.includes('redis')) {
    return `${base} (Redis). Answer with raw Redis commands that run DIRECTLY in the query console — e.g. \`GET user:1\`, \`HGETALL user:1\`, \`SCAN 0 MATCH user:* COUNT 100\`, \`ZREVRANGE leaderboard 0 9 WITHSCORES\`. NEVER wrap them in a CLI invocation such as \`redis-cli\` and do not include the connection string. Write ONE command per fenced code block. Prefer SCAN over KEYS to enumerate keys. Destructive/admin commands (FLUSHALL, FLUSHDB, CONFIG, EVAL, SCRIPT, SHUTDOWN, SAVE, MIGRATE…) are disabled in the console — never suggest them. There is NO SQL in Redis; never emit SELECT/FROM or claim SQL is unavailable — just give the Redis command.`
  }

  // Relational engines — use the engine's SQL dialect.
  const dialect = engine ? `the ${engine} SQL dialect` : 'standard SQL'
  return `${base}${engine ? ` (${engine})` : ''}. Answer with ${dialect} that runs DIRECTLY in the query console — never a CLI wrapper. Put SQL in a fenced code block.`
}
