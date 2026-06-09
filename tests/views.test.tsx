import { render, screen } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { HomeView, SettingsView } from '../src/components/views'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('HomeView renders recent sessions section', () => {
  wrap(<HomeView onOpen={() => {}} onNew={() => {}} owned userName="skyler" />)
  expect(screen.getByText('最近会话')).toBeTruthy() // default zh
})
it('SettingsView renders without crashing', () => {
  wrap(<SettingsView theme="dawn" onTheme={() => {}} onClose={() => {}} />)
})
