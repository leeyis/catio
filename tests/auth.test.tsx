import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import { NewConnectionModal } from '../src/components/modals'
import { AuthGate } from '../src/components/auth'
const wrap = (ui: React.ReactNode) => render(<LanguageProvider><DataProvider>{ui}</DataProvider></LanguageProvider>)
it('NewConnectionModal renders title', () => {
  wrap(<NewConnectionModal onClose={() => {}} />)
  expect(screen.getByText('新建连接')).toBeTruthy()
})
it('AuthGate renders (first-run or lock)', () => {
  wrap(<AuthGate users={[]} onCreate={() => {}} onLogin={async () => false} />)
})
