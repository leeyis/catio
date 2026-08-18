import { describe, it, expect } from 'vitest'
import { parseAnsi } from './ansiSpans'

describe('parseAnsi', () => {
  it('returns a single plain span when there is no escape sequence', () => {
    // 快路径：绝大多数工具输出走这里。
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })

  it('returns nothing for empty input', () => {
    expect(parseAnsi('')).toEqual([])
  })

  it('splits colored segments and keeps the surrounding text', () => {
    const spans = parseAnsi('ok \x1b[31mFAILED\x1b[0m done')
    expect(spans).toEqual([
      { text: 'ok ' },
      { text: 'FAILED', className: 'ansi-red' },
      { text: ' done' },
    ])
  })

  it('carries style across until reset', () => {
    const spans = parseAnsi('\x1b[32mline1\nline2\x1b[0mplain')
    expect(spans[0]).toEqual({ text: 'line1\nline2', className: 'ansi-green' })
    expect(spans[1]).toEqual({ text: 'plain' })
  })

  it('combines bold with a foreground color', () => {
    const [span] = parseAnsi('\x1b[1;31merror\x1b[0m')
    expect(span).toEqual({ text: 'error', className: 'ansi-red', bold: true })
  })

  it('treats ESC[m as a full reset', () => {
    const spans = parseAnsi('\x1b[31mred\x1b[mplain')
    expect(spans[1]).toEqual({ text: 'plain' })
  })

  it('resets only the attribute the code targets', () => {
    // 22 复位 bold/dim 但保留颜色；39 复位颜色但保留 bold。
    const a = parseAnsi('\x1b[1;31mboth\x1b[22mcolor-only')
    expect(a[1]).toEqual({ text: 'color-only', className: 'ansi-red' })
    const b = parseAnsi('\x1b[1;31mboth\x1b[39mbold-only')
    expect(b[1]).toEqual({ text: 'bold-only', bold: true })
  })

  it('strips non-SGR control sequences instead of printing them', () => {
    // 这是本模块存在的第二个理由：清屏/光标移动无法渲染，若不剥离就会变成乱码字面量。
    expect(parseAnsi('a\x1b[2Jb\x1b[1;1Hc')).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    // \x1b[K（清行）同理。
    expect(parseAnsi('prog\x1b[Kress')).toEqual([{ text: 'prog' }, { text: 'ress' }])
  })

  it('drops a stray trailing ESC rather than leaking a control byte into the DOM', () => {
    expect(parseAnsi('text\x1b')).toEqual([{ text: 'text' }])
    // 被截断的序列（流式输出常见）也不应产出控制字符。
    const spans = parseAnsi('text\x1b[')
    expect(spans.every(s => !s.text.includes('\x1b'))).toBe(true)
  })

  it('ignores background and 256-color codes without emitting garbage', () => {
    // 背景色会破坏面板底色，故只识别不应用；文本必须完好。
    expect(parseAnsi('\x1b[41mtext\x1b[0m')).toEqual([{ text: 'text' }])
    expect(parseAnsi('\x1b[38;5;196mtext\x1b[0m')).toEqual([{ text: 'text' }])
  })

  it('handles bright foreground colors', () => {
    const [span] = parseAnsi('\x1b[91mbright\x1b[0m')
    expect(span).toEqual({ text: 'bright', className: 'ansi-bright-red' })
  })

  it('never loses visible characters', () => {
    // 属性断言：剥离转义后，可见字符必须与手工去除 ANSI 的结果一致。
    const raw = '\x1b[32m✓\x1b[0m 12 passed \x1b[31m✗\x1b[0m 1 failed\n\x1b[2Kdone'
    const joined = parseAnsi(raw).map(s => s.text).join('')
    expect(joined).toBe('✓ 12 passed ✗ 1 failed\ndone')
  })
})
