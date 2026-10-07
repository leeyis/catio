import { beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { canRevealExport, revealExportedFile } from './exportReveal'
const h=vi.hoisted(()=>({native:false,server:false,reveal:vi.fn()}))
vi.mock('./transport',()=>({isTauri:()=>h.native,isServer:()=>h.server}))
vi.mock('@tauri-apps/plugin-opener',()=>({revealItemInDir:h.reveal}))
beforeEach(()=>{h.native=true;h.server=false;vi.clearAllMocks()})
it('only reveals exact native absolute paths, never opens the file as a program',async()=>{
  for(const path of ['C:\\qa\\export.sql','/tmp/export with spaces.sql','\\\\server\\share\\export.sql'])await revealExportedFile(path)
  expect(h.reveal.mock.calls).toEqual([['C:\\qa\\export.sql'],['/tmp/export with spaces.sql'],['\\\\server\\share\\export.sql']])
})
it.each(['', ' ', 'relative.sql','https://example.com/a','file:///tmp/a','/tmp/bad\0.sql'])('rejects invalid path %s',async path=>{
  await expect(revealExportedFile(path)).rejects.toThrow();expect(h.reveal).not.toHaveBeenCalled()
})
it('never routes Web results or a server filesystem path to a local opener',async()=>{
  h.server=true;expect(canRevealExport()).toBe(false)
  await expect(revealExportedFile('/srv/private.sql')).rejects.toThrow('desktop')
  h.server=false;h.native=false
  await expect(revealExportedFile('/srv/private.sql')).rejects.toThrow('desktop')
  expect(h.reveal).not.toHaveBeenCalled()
})
it('has the specific reveal permission without widening open-path to arbitrary files',()=>{
  const config=JSON.parse(readFileSync('src-tauri/capabilities/default.json','utf8'))
  expect(config.permissions).toContain('opener:allow-reveal-item-in-dir')
  expect(config.permissions).not.toContain('opener:allow-open-path')
})
