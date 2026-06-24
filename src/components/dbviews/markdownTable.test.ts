import { describe, it, expect } from 'vitest'
import { buildMarkdownTable } from './markdownTable'

// Markdown 管道表格导出的纯函数单测。语义对齐 DBX text_export.rs::format_markdown:
// 转义 | → \|、换行 → <br>、null → NULL、列宽对齐(每列至少 3 个 -)。

describe('buildMarkdownTable', () => {
  it('转义管道符与换行,列宽对齐(对齐 DBX format_markdown)', () => {
    const out = buildMarkdownTable(
      ['id', 'payload|kind'],
      [[1, 'a|b'], [2, 'line one\nline two']],
    )
    expect(out).toBe([
      '| id  | payload\\|kind        |',
      '| --- | -------------------- |',
      '| 1   | a\\|b                 |',
      '| 2   | line one<br>line two |',
      '',
    ].join('\n'))
  })

  it('null/undefined → NULL,布尔 → true/false', () => {
    const out = buildMarkdownTable(
      ['a', 'b', 'c'],
      [[null, true, false], [undefined, 1, 'x']],
    )
    expect(out).toBe([
      '| a    | b    | c     |',
      '| ---- | ---- | ----- |',
      '| NULL | true | false |',
      '| NULL | 1    | x     |',
      '',
    ].join('\n'))
  })

  it('对象/数组 → JSON 编码', () => {
    const out = buildMarkdownTable(['v'], [[{ a: 1 }], [[1, 2]]])
    expect(out).toContain('| {"a":1} |')
    expect(out).toContain('| [1,2]   |')
  })

  it('无数据行只输出表头 + 分隔行', () => {
    const out = buildMarkdownTable(['id', 'name'], [])
    expect(out).toBe(['| id  | name |', '| --- | ---- |', ''].join('\n'))
  })

  it('空列返回空串', () => {
    expect(buildMarkdownTable([], [[1]])).toBe('')
  })

  it('CRLF 换行也替换为单个 <br>', () => {
    const out = buildMarkdownTable(['x'], [['a\r\nb']])
    expect(out).toContain('a<br>b')
    expect(out).not.toContain('<br><br>')
  })
})
