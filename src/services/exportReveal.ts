import { isServer, isTauri } from './transport'

export function canRevealExport():boolean {return isTauri() && !isServer()}
/** Only reveal a completed, native save's exact path. Never execute/open the exported SQL. */
export async function revealExportedFile(path:string):Promise<void> {
  if (!canRevealExport()) throw new Error('File reveal is only available in the desktop app')
  if (!path.trim() || path.includes('\0') || !(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path))) throw new Error('Expected an absolute local export path')
  const {revealItemInDir}=await import('@tauri-apps/plugin-opener')
  await revealItemInDir(path)
}
