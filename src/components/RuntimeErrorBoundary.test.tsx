import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeErrorBoundary } from './RuntimeErrorBoundary'

const mocks = vi.hoisted(() => ({ open: vi.fn(), report: vi.fn() }))
vi.mock('../services/diagnostics', () => ({ openDiagnosticLogDirectory: mocks.open }))
vi.mock('../services/runtimeDiagnostics', () => ({ reportRuntimeEvent: mocks.report }))

beforeEach(() => {
  localStorage.clear()
  mocks.open.mockReset().mockResolvedValue(undefined)
  mocks.report.mockReset()
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

function Broken(): never { throw new ReferenceError('structuredClone is not defined') }

it('replaces a crashed React tree with recovery actions and records the error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<RuntimeErrorBoundary><Broken /></RuntimeErrorBoundary>)
  expect(screen.getByRole('alert')).toHaveTextContent('界面遇到异常')
  expect(mocks.report).toHaveBeenCalledWith('react-error', expect.any(ReferenceError))
  fireEvent.click(screen.getByRole('button', { name: '打开诊断日志' }))
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
})

it('shows an English fallback and log locations if the native opener fails', async () => {
  localStorage.setItem('catio-lang', 'en')
  mocks.open.mockRejectedValue(new Error('unavailable'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<RuntimeErrorBoundary><Broken /></RuntimeErrorBoundary>)
  fireEvent.click(screen.getByRole('button', { name: 'Open diagnostic logs' }))
  await screen.findByText(/%LOCALAPPDATA%/)
  expect(screen.getByRole('button', { name: 'Reload interface' })).toBeVisible()
})

it('records readiness when the normal interface mounts', () => {
  render(<RuntimeErrorBoundary><div>Ready</div></RuntimeErrorBoundary>)
  expect(screen.getByText('Ready')).toBeVisible()
  expect(mocks.report).toHaveBeenCalledWith('frontend-ready')
})
