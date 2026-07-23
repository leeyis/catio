import { render } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { Btn, StatusDot, ConnGlyph } from '../src/components/atoms'
import { DATA } from '../src/services/mockData'
import type { Connection } from '../src/services/types'
it('atoms render without crashing', () => {
  const conn = DATA.connections[0]
  const { container } = render(
    <DataProvider>
      <Btn>hi</Btn>
      <StatusDot status="up" size={6} />
      <ConnGlyph conn={conn} size={30} radius={8} />
    </DataProvider>
  )
  expect(container.querySelector('svg, div, button')).toBeTruthy()
})

it('centers connection brand marks in a theme-independent logo tile', () => {
  const ubuntu: Connection = {
    id: 'ubuntu-host', group: '', kind: 'host', name: 'Ubuntu', sub: '', icon: 'server', status: 'up', os: 'ubuntu', proto: 'ssh',
  }
  const { container } = render(
    <DataProvider>
      <ConnGlyph conn={ubuntu} size={30} radius={8} />
    </DataProvider>
  )

  const tile = container.firstElementChild
  expect(tile).toHaveClass('connection-logo')
  expect(tile).toHaveStyle({ padding: '4px' })
  expect(tile?.firstElementChild).toHaveStyle({ width: '100%', height: '100%' })
  expect(tile?.firstElementChild?.tagName).toBe('IMG')
})
