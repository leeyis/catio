import { render } from '@testing-library/react'
import { DataProvider } from '../src/state/DataContext'
import { Btn, StatusDot, ConnGlyph } from '../src/components/atoms'
import { DATA } from '../src/services/mockData'
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
