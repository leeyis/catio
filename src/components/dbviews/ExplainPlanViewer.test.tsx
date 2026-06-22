import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../../state/LanguageContext'
import i18n from '../../i18n'
import { ExplainPlanViewer } from './ExplainPlanViewer'
import type { ParsedExplainPlan } from './explainPlan'

const plan: ParsedExplainPlan = {
  databaseType: 'postgres',
  raw: [{ Plan: { 'Node Type': 'Seq Scan' } }],
  nodes: [
    {
      id: '0', title: 'Seq Scan on users', nodeType: 'Seq Scan', relation: 'users',
      cost: '0..25.5', rows: '1200', details: ['Filter: (id = 1)'],
      children: [
        { id: '0.0', title: 'Index Scan on orders', nodeType: 'Index Scan', relation: 'orders', index: 'orders_pkey', cost: '8.3', rows: '1', details: [], children: [] },
      ],
    },
  ],
}

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>)

describe('ExplainPlanViewer', () => {
  beforeAll(async () => { await i18n.changeLanguage('en') })

  it('renders the tree view by default showing node titles', () => {
    wrap(<ExplainPlanViewer plan={plan} />)
    expect(screen.getByText('Seq Scan on users')).toBeInTheDocument()
    expect(screen.getByText('Index Scan on orders')).toBeInTheDocument()
  })

  it('shows a loading state when loading', () => {
    wrap(<ExplainPlanViewer loading />)
    expect(screen.getByText(i18n.t('explain.running'))).toBeInTheDocument()
  })

  it('shows the error message when given an error', () => {
    wrap(<ExplainPlanViewer error="boom" />)
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('switches to JSON view and renders the raw plan json', () => {
    wrap(<ExplainPlanViewer plan={plan} />)
    fireEvent.click(screen.getByTestId('explain-view-json'))
    // The raw JSON contains the node type key.
    expect(screen.getByTestId('explain-json').textContent).toContain('Seq Scan')
  })

  it('switches to summary (table) view listing relation and index', () => {
    wrap(<ExplainPlanViewer plan={plan} />)
    fireEvent.click(screen.getByTestId('explain-view-summary'))
    expect(screen.getByText('orders_pkey')).toBeInTheDocument()
  })
})
