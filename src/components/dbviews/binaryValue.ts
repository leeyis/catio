import type { BinaryCell } from '../../services/types'

export const validBinaryHex = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)

export function binarySqlLiteral(value: unknown, engine: string): string {
  if (value == null) return 'NULL'
  if (!validBinaryHex(value)) throw new Error('Binary values require 0x followed by an even number of hexadecimal digits')
  const hex=value.slice(2)
  if (engine === 'postgres') return `decode('${hex}', 'hex')`
  if (engine === 'sqlserver') return `0x${hex}`
  if (engine === 'duckdb') return `from_hex('${hex}')`
  if (engine === 'clickhouse') return `unhex('${hex}')`
  return `X'${hex}'`
}

export function removeBinaryColumn(cells: BinaryCell[] | undefined, column: number): BinaryCell[] | undefined {
  if (!cells || column < 0) return cells
  return cells.filter(([,c])=>c!==column).map(([r,c])=>[r,c-(c>column?1:0)])
}

export function selectBinaryRows(cells: BinaryCell[] | undefined, rows: number[]): BinaryCell[] {
  const positions=new Map(rows.map((r,i)=>[r,i]))
  return (cells??[]).flatMap(([r,c]): BinaryCell[] => {
    const index=positions.get(r)
    return index === undefined ? [] : [[index,c]]
  })
}
