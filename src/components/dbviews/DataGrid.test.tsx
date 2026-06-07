import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import { DataGrid } from './DataGrid'
import type { ResultColumn } from '../../services/types'

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('DataGrid generic rows', () => {
  it('renders columns and indexed row values', () => {
    const columns: ResultColumn[] = [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text' },
    ]
    const rows: unknown[][] = [[1, 'alice'], [2, 'bob']]
    wrap(<DataGrid columns={columns} rows={rows} statusTones={{}} density="comfortable" />)
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('id')).toBeInTheDocument()
  })
})
