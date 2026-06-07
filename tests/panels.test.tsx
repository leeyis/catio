import { render } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { AIPanel, MonitorPanel, SnippetsPanel, TunnelsPanel, HistoryPanel, SftpPanel, DetailsPanel } from '../src/components/panels'
import { DATA } from '../src/services/mockData'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('panels render without crashing', () => {
  wrap(<AIPanel onClose={() => {}} mode="sql" conn={DATA.byId['d-orders']} attachment={null} onClearAttachment={() => {}} />)
  wrap(<MonitorPanel onClose={() => {}} conn={DATA.byId['h-web1']} />)
  wrap(<SnippetsPanel onClose={() => {}} snippets={DATA.snippets} />)
  wrap(<TunnelsPanel onClose={() => {}} />)
  wrap(<HistoryPanel onClose={() => {}} />)
  wrap(<SftpPanel onClose={() => {}} conn={DATA.byId['h-web1']} />)
  wrap(<DetailsPanel onClose={() => {}} conn={DATA.byId['d-orders']} />)
})
