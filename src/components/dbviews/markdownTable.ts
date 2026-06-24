/**
 * 把结果集/网格行渲染成 GitHub 风格的 Markdown 管道表格(导出菜单「Markdown(.md)」)。
 *
 * 语义对齐 DBX crates/dbx-core/src/text_export.rs::format_markdown:
 *   - 表头 + 分隔行(每列至少 3 个 `-`)+ 数据行,首尾各一根管道。
 *   - 单元格内的 `|` 转义为 `\|`,`\r\n`/`\n` 替换为 `<br>`(避免破坏行/列结构)。
 *   - null/undefined 显示为 `NULL`,布尔 true/false,数字原样,对象/数组 JSON 编码。
 *   - 列宽按该列(表头 + 所有单元格)的最大显示宽度对齐(右侧补空格)。
 * 纯函数,不触碰 DOM/剪贴板,便于单测。
 */

/** 单元格值 → 显示文本(转义前)。对齐 text_export::display_cell。 */
function displayCell(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** 转义管道与换行,使单元格不破坏表格结构(对齐 text_export::markdown_cell)。 */
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r\n/g, '<br>').replace(/\n/g, '<br>')
}

/** 显示宽度:按 Unicode 码点计数(与 DBX chars().count() 一致,不做东亚全角加权)。 */
function displayWidth(s: string): number {
  return [...s].length
}

function pad(s: string, width: number): string {
  const cur = displayWidth(s)
  return cur >= width ? s : s + ' '.repeat(width - cur)
}

/**
 * 生成 Markdown 管道表格字符串(末尾带一个换行)。空列时返回空串。
 */
export function buildMarkdownTable(columns: string[], rows: unknown[][]): string {
  if (columns.length === 0) return ''
  const headerCells = columns.map(escapeCell)
  const bodyCells = rows.map(row => columns.map((_, ci) => escapeCell(displayCell(row[ci]))))

  const widths = columns.map((_, ci) => {
    const colMax = bodyCells.reduce((m, row) => Math.max(m, displayWidth(row[ci] ?? '')), 0)
    return Math.max(displayWidth(headerCells[ci]), colMax, 3)
  })

  const header = `| ${headerCells.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`
  const separator = `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`
  const body = bodyCells.map(row => `| ${row.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`)

  return [header, separator, ...body].join('\n') + '\n'
}
