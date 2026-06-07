import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '../src/state/LanguageContext'
import { DataProvider } from '../src/state/DataContext'
import App from '../src/App'

const wrap = () => render(<LanguageProvider><DataProvider><App /></DataProvider></LanguageProvider>)

it('renders home view by default with hero', () => {
  wrap()
  // stable zh string from HomeView hero (home.heroTitle)
  expect(screen.getAllByText(/服务器与数据库/).length).toBeGreaterThan(0)
})

it('theme toggle changes data-theme attribute', () => {
  wrap()
  const before = document.documentElement.getAttribute('data-theme')
  // find the theme toggle button by its title (shell.toggleTheme zh '切换主题')
  const btn = screen.getByTitle('切换主题')
  fireEvent.click(btn)
  const after = document.documentElement.getAttribute('data-theme')
  expect(after).not.toBe(before)
})
