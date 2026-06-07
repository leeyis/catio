import { render } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataGrid, StructureView, ERDiagram } from '../src/components/dbviews'
import { DATA } from '../src/services/mockData'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('dbviews render without crashing', () => {
  wrap(<DataGrid columns={DATA.ordersColumns} rows={DATA.ordersRows} statusTones={DATA.statusTones} />)
  wrap(<StructureView table="orders" />)
  wrap(<ERDiagram />)
})
