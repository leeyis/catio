import { render } from '@testing-library/react'
import { Icon } from '../src/components/Icon'
it('renders a known icon as svg', () => {
  const { container } = render(<Icon name="server" size={16} />)
  expect(container.querySelector('svg')).toBeTruthy()
})
