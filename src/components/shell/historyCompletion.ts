/**
 * Pure history-based shell completion engine.
 *
 * Plans inline completion candidates (and a "ghost" suffix for the top hit)
 * from the host-filtered raw shell history. Kept as a pure function with no
 * terminal/DOM coupling so it can be unit-tested in isolation — mirrors the
 * planner style of dbviews/mongoCompletion.ts.
 */

/** 一条原始 shell 历史:text 为命令文本,ts 为 epoch 秒(越大越新)。 */
export interface ShellHistoryEntry {
  text: string
  ts: number
}

/** 一条补全候选。 */
export interface HistoryMatch {
  text: string
  ts: number
}

export interface HistoryCompletionResult {
  /** 排好序、去重、截断后的候选列表。 */
  items: HistoryMatch[]
  /**
   * 仅当 items[0] 为「严格大小写前缀命中」时,给出输入之后应当补全的剩余串;
   * 否则为 null。
   */
  ghost: string | null
}

/**
 * 规划基于历史的补全。
 *
 * entries 为已按主机筛过的原始历史(可能含重复、顺序任意)。引擎负责:
 *  ① 按 text 去重,保留 ts 最大的一条;
 *  ② 按 ts 降序(最近优先)排序;
 *  ③ 前缀命中(忽略大小写)排在最前,其后为「子串命中但非前缀」,组内仍最近优先;
 *  ④ 排除 text === input 的项(无可补全);
 *  ⑤ opts.limit(默认 50)截断 items;
 *  ⑥ ghost:仅当 items[0] 为严格大小写前缀命中时给出剩余串,否则 null。
 */
export function planHistoryCompletion(
  input: string,
  entries: ShellHistoryEntry[],
  opts?: { limit?: number },
): HistoryCompletionResult {
  if (!input) return { items: [], ghost: null }

  // ① 去重:同一 text 仅保留 ts 最大的一条。
  const byText = new Map<string, HistoryMatch>()
  for (const e of entries) {
    const existing = byText.get(e.text)
    if (!existing || e.ts > existing.ts) {
      byText.set(e.text, { text: e.text, ts: e.ts })
    }
  }

  const lower = input.toLowerCase()
  const prefixHits: HistoryMatch[] = []
  const substringHits: HistoryMatch[] = []

  for (const m of byText.values()) {
    if (m.text === input) continue // ④ 与输入完全相同,无可补全
    const t = m.text.toLowerCase()
    if (t.startsWith(lower)) {
      prefixHits.push(m)
    } else if (t.includes(lower)) {
      substringHits.push(m)
    }
  }

  // ② 组内按 ts 降序(最近优先)。
  const byRecency = (a: HistoryMatch, b: HistoryMatch) => b.ts - a.ts
  prefixHits.sort(byRecency)
  substringHits.sort(byRecency)

  // ③ 前缀组在前,子串组在后。
  const ordered = [...prefixHits, ...substringHits]

  // ⑤ 截断。
  const limit = opts?.limit ?? 50
  const items = ordered.slice(0, limit)

  // ⑥ ghost:仅严格大小写前缀命中时给出。
  const top = items[0]
  const ghost = top && top.text.startsWith(input) ? top.text.slice(input.length) : null

  return { items, ghost }
}
