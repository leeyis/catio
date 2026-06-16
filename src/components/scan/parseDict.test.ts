import { describe, it, expect } from 'vitest'
import { parseDict } from './parseDict'

describe('parseDict', () => {
  it('解析普通行', () => {
    expect(parseDict('root 123456')).toEqual([{ user: 'root', password: '123456' }])
  })

  it('含空格密码：仅按第一个空白切分，其余整体为密码', () => {
    expect(parseDict('admin pass word 1')).toEqual([
      { user: 'admin', password: 'pass word 1' },
    ])
  })

  it('忽略空行', () => {
    const text = 'root 123\n\n   \nadmin abc'
    expect(parseDict(text)).toEqual([
      { user: 'root', password: '123' },
      { user: 'admin', password: 'abc' },
    ])
  })

  it('仅用户名（无密码）的行被忽略', () => {
    expect(parseDict('root\nadmin secret')).toEqual([
      { user: 'admin', password: 'secret' },
    ])
  })

  it('首尾空白被 trim', () => {
    expect(parseDict('  root   123456  ')).toEqual([
      { user: 'root', password: '123456' },
    ])
  })

  it('多行混合 + CRLF', () => {
    const text = 'root 123456\r\nadmin admin123\r\n'
    expect(parseDict(text)).toEqual([
      { user: 'root', password: '123456' },
      { user: 'admin', password: 'admin123' },
    ])
  })

  it('兼容冒号分隔写法', () => {
    expect(parseDict('root:123456')).toEqual([{ user: 'root', password: '123456' }])
  })

  it('空格在前时冒号视为密码的一部分', () => {
    expect(parseDict('root my:secret')).toEqual([{ user: 'root', password: 'my:secret' }])
  })

  it('忽略 # 注释行', () => {
    expect(parseDict('# 注释\nroot 123')).toEqual([{ user: 'root', password: '123' }])
  })
})
