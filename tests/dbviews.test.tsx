import { render } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataGrid, StructureView, ERDiagram } from '../src/components/dbviews'
import { DATA } from '../src/services/mockData'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('dbviews render without crashing', () => {
  // Map ordersColumns/ordersRows to generic ResultColumn/unknown[][] shape
  const columns = DATA.ordersColumns.map(c => ({ name: c.name, type: c.type, pk: c.pk, fk: c.fk }))
  const keys = DATA.ordersColumns.map(c => c.name)
  const rows = DATA.ordersRows.map(r => keys.map(k => (r as unknown as Record<string, unknown>)[k]))
  wrap(<DataGrid columns={columns} rows={rows} statusTones={DATA.statusTones} />)
  wrap(<StructureView table="orders" />)
  wrap(<ERDiagram />)
})
