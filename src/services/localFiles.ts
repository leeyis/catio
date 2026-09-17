import { isTauri, rpc } from './transport'

/** Configuration only: file tools run in Rust after Agent policy/approval. */
export async function configureLocalWorkspace(path: string | null): Promise<string | null> {
  if (!isTauri()) throw new Error('workspaceDesktopOnly')
  return rpc<string | null>('agent_set_workspace', { path })
}

export async function chooseLocalWorkspace(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) throw new Error('workspaceDesktopOnly')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, ...(defaultPath ? { defaultPath } : {}) })
  return typeof selected === 'string' ? selected : null
}
