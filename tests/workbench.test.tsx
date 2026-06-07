import { render, screen } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { TerminalPane, DbWorkbench } from '../src/components/workbench'
import { DATA } from '../src/services/mockData'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('TerminalPane renders terminal buffer text', () => {
  wrap(<TerminalPane conn={DATA.byId['h-bastion']} />)
  // a substring from termLines (mock data, not translated)
  expect(screen.getAllByText(/db-bastion|callback/i).length).toBeGreaterThan(0)
})
it('DbWorkbench renders schema table name orders', () => {
  wrap(<DbWorkbench conn={DATA.byId['d-orders']} />)
  expect(screen.getAllByText(/orders/i).length).toBeGreaterThan(0)
})
