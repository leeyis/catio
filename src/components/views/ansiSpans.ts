// ANSI SGR → 带样式的片段，供 MCP 实时日志的控制台式高亮使用。
//
// 为什么不装依赖：需求只是「把工具输出里的颜色显示出来」。SGR 里我们真正会遇到的
// 只有 30-37/90-97（前景）、1（粗）、2（暗）、3（斜）、4（下划线）、0/22-24/39（复位）。
// 一个小解析器就够，且顺带解决另一个必须处理的问题——**剥掉**无法渲染的转义序列
// （光标移动、清屏等），否则它们会以乱码字面量出现在日志里。
//
// 安全：只产出 { text, style } 数据，由 React 按文本节点渲染，绝不生成 HTML 字符串，
// 因此远端输出无法注入标记。

/** 一段颜色/字重一致的文本。`style` 为空表示用容器默认样式。 */
export interface AnsiSpan {
  text: string
  className?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

/** SGR 前景色 → CSS 变量类名（在 tokens.css 里定义，跟随主题）。 */
const FG: Record<number, string> = {
  30: 'ansi-black',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  37: 'ansi-white',
  90: 'ansi-bright-black',
  91: 'ansi-bright-red',
  92: 'ansi-bright-green',
  93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue',
  95: 'ansi-bright-magenta',
  96: 'ansi-bright-cyan',
  97: 'ansi-bright-white',
}

// CSI 序列：ESC [ 参数 中间字节 最终字节。只有最终字节 'm'（SGR）会改样式，
// 其余（A-L 光标移动、J 清屏、K 清行…）被识别后丢弃，不作为文本输出。
const CSI = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g

/** 当前样式状态。 */
interface State {
  className?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function applySgr(state: State, params: string): State {
  // 空参数（ESC[m）等同 ESC[0m。
  const codes = params === '' ? [0] : params.split(';').map(p => (p === '' ? 0 : Number(p)))
  let next = { ...state }
  for (const code of codes) {
    if (Number.isNaN(code)) continue
    if (code === 0) next = {}
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) { next.bold = undefined; next.dim = undefined }
    else if (code === 23) next.italic = undefined
    else if (code === 24) next.underline = undefined
    else if (code === 39) next.className = undefined
    else if (FG[code]) next.className = FG[code]
    // 背景色 40-47/100-107 与 256/truecolor（38;5;n / 38;2;r;g;b）不渲染：
    // 日志面板有自己的底色，背景色会破坏可读性。识别后忽略即可。
  }
  return next
}

/**
 * 把含 ANSI 转义的文本切成样式片段。
 *
 * 无转义序列时返回单个无样式片段（常见情形，零开销）。不可渲染的 CSI 序列被剥离；
 * 孤立的 ESC 字节也被丢弃，避免终端控制字符出现在 DOM 里。
 */
export function parseAnsi(input: string): AnsiSpan[] {
  if (!input) return []
  // 快路径：绝大多数工具输出没有转义序列。
  if (!input.includes('\x1b')) return [{ text: input }]

  const spans: AnsiSpan[] = []
  let state: State = {}
  let last = 0
  CSI.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CSI.exec(input)) !== null) {
    if (m.index > last) {
      const text = input.slice(last, m.index)
      if (text) spans.push({ text, ...state })
    }
    if (m[3] === 'm') state = applySgr(state, m[1])
    // 其余最终字节：识别并丢弃（光标移动/清屏等无法在静态日志里表达）。
    last = m.index + m[0].length
  }
  if (last < input.length) {
    // 尾部可能残留孤立 ESC（被截断的序列），一并去掉。
    const text = input.slice(last).replace(/\x1b/g, '')
    if (text) spans.push({ text, ...state })
  }
  return spans
}
