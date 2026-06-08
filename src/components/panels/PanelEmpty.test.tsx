import { render } from '@testing-library/react'
import { PanelEmpty } from './PanelEmpty'
import { describe, it, expect } from 'vitest'

describe('PanelEmpty', () => {
  it('renders icon hint', () => {
    const { getByText } = render(<PanelEmpty icon="folder" text="先连接一个主机" />)
    expect(getByText('先连接一个主机')).toBeTruthy()
  })
})
