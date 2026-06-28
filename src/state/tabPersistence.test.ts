import { describe, it, expect, beforeEach } from 'vitest'
import { saveOpenTabs, restoreOpenTabs } from './tabPersistence'
import type { Tab } from '../services/types'

describe('tabPersistence', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing persisted', () => {
    expect(restoreOpenTabs()).toBeNull()
  })

  it('restores only SSH-terminal and DB-sql tabs backed by a saved profile', () => {
    localStorage.setItem('catio-connections', JSON.stringify([{ id: 'live-h:22-u', name: 'host', host: 'h', port: 22, user: 'u', auth: { method: 'password' } }]))
    localStorage.setItem('catio-db-connections', JSON.stringify([{ id: 'db-x', name: 'pg', dbType: 'postgres', host: 'h', port: 5432, user: 'u' }]))
    const tabs: Tab[] = [
      { id: 't1', kind: 'terminal', connId: 'live-h:22-u', title: 'host' },        // SSH → keep
      { id: 't2', kind: 'terminal', connId: 'term-local-0', title: 'Local' },       // transient → drop
      { id: 't3', kind: 'sql', connId: 'db-x', title: 'pg' },                       // DB → keep
      { id: 't4', kind: 'remote-file', connId: 'live-h:22-u', title: 'f', path: '/etc/x' }, // remote-file → drop
      { id: 't5', kind: 'terminal', connId: 'live-gone:22-u', title: 'gone' },      // no profile → drop
    ]
    saveOpenTabs(tabs, 't3')

    const r = restoreOpenTabs()
    expect(r).not.toBeNull()
    expect(r!.tabs.map(t => t.id)).toEqual(['t1', 't3'])
    expect(r!.activeTab).toBe('t3')
  })

  it('falls back activeTab to the last restored tab when the saved active was dropped', () => {
    localStorage.setItem('catio-connections', JSON.stringify([{ id: 'live-h:22-u', name: 'h', host: 'h', port: 22, user: 'u', auth: { method: 'password' } }]))
    saveOpenTabs([{ id: 't1', kind: 'terminal', connId: 'live-h:22-u', title: 'h' }], 'dropped-active')
    expect(restoreOpenTabs()!.activeTab).toBe('t1')
  })
})
