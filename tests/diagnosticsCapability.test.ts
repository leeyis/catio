// UI mocks bypass Tauri ACL. Guard the packaged permission separately so a
// successful mocked openPath call cannot hide a broken desktop capability.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('allows the main window to open exactly the application log directory', () => {
  const capability = JSON.parse(readFileSync(resolve('src-tauri/capabilities/default.json'), 'utf8'))
  expect(capability.windows).toContain('main')
  expect(capability.permissions).toContainEqual(expect.objectContaining({
    identifier: 'opener:allow-open-path',
    allow: [{ path: '$APPLOG' }],
  }))
})
