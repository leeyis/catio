import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { LanguageProvider } from '../src/state/LanguageContext'
import { HomeView } from '../src/components/views'
import { IconRail, Sidebar } from '../src/components/shell/Sidebar'
import type { Connection } from '../src/services/types'

const RECENT_CONN: Connection = {
  id: 'recent-host',
  group: '',
  kind: 'host',
  name: 'recent-host',
  sub: 'deploy@example.com:22',
  icon: 'server',
  status: 'idle',
  proto: 'ssh',
}

function wrap(ui: React.ReactNode) {
  return render(
    <LanguageProvider>
      <DataProvider>{ui}</DataProvider>
    </LanguageProvider>
  )
}

describe('compact workspace layout', () => {
  it('renders the home hierarchy with compact spacing and 8px content cards', () => {
    wrap(<HomeView onOpen={() => {}} onNew={() => {}} onAutoScan={() => {}} owned />)

    const heroTitle = screen.getByRole('heading', { level: 1 })
    const hero = heroTitle.parentElement?.parentElement?.parentElement as HTMLElement
    const content = hero.parentElement as HTMLElement
    const heroRow = hero.firstElementChild as HTMLElement
    const heroCopy = heroRow.firstElementChild as HTMLElement
    const stats = heroCopy.lastElementChild as HTMLElement
    const recentHeading = screen.getByRole('heading', { level: 2 })
    const sectionHead = recentHeading.parentElement?.parentElement as HTMLElement
    const empty = screen.getByText('暂无最近会话').parentElement as HTMLElement

    expect(content).toHaveStyle({ padding: '24px 28px 36px' })
    expect(hero).toHaveStyle({ borderRadius: '8px', padding: '20px 22px', marginBottom: '22px' })
    expect(heroRow).toHaveStyle({ gap: '16px' })
    expect(heroCopy).toHaveStyle({ gap: '12px' })
    expect(stats).toHaveClass('gap12')
    expect(stats).toHaveStyle({ marginTop: '2px' })
    expect(sectionHead).toHaveStyle({ marginBottom: '10px' })
    expect(empty).toHaveStyle({ borderRadius: '8px', padding: '20px 14px', gap: '6px' })
  })

  it('renders recent-session cards with the compact content-card rhythm', () => {
    wrap(
      <HomeView
        onOpen={() => {}}
        onNew={() => {}}
        onAutoScan={() => {}}
        owned
        recent={[{ conn: RECENT_CONN, ts: 1_700_000_000_000 }]}
      />
    )

    const name = screen.getByText('recent-host')
    const row = name.parentElement?.parentElement?.parentElement as HTMLElement

    expect(row).toHaveStyle({ borderRadius: '8px', padding: '8px 12px', gap: '10px' })
  })

  it('uses compact internal spacing in the Vault panel', () => {
    const { container } = wrap(
      <Sidebar onOpen={() => {}} authEnabled={false} currentUser="" conns={[]} />
    )
    const panel = container.querySelector('.card-surface') as HTMLElement
    const header = panel.firstElementChild as HTMLElement
    const headerTop = header.firstElementChild as HTMLElement
    const search = header.children[1] as HTMLElement
    const empty = screen.getByText('暂无收藏').parentElement?.parentElement as HTMLElement

    expect(header).toHaveStyle({ padding: '10px 10px 8px' })
    expect(headerTop).toHaveStyle({ marginBottom: '8px' })
    expect(search).toHaveStyle({ marginBottom: '6px' })
    expect(panel.children[1]).toHaveStyle({ padding: '2px 6px 8px' })
    expect(empty).toHaveStyle({ padding: '24px 12px', gap: '8px' })
    expect(panel.lastElementChild).toHaveStyle({ padding: '8px 10px' })
  })

  it('uses compact internal spacing in the tool rail', () => {
    const { container } = wrap(
      <IconRail active="" panelOpen={false} onSelect={() => {}} onMcp={() => {}} />
    )
    const panel = container.querySelector('.card-surface') as HTMLElement

    expect(panel).toHaveStyle({ padding: '10px 6px' })
    expect(panel.firstElementChild).toHaveStyle({ gap: '8px' })
  })
})
