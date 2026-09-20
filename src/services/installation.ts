import { isServer, isTauri, rpc } from './transport'

export interface InstallationSettings { showRepository: boolean }

export async function installationSettings(): Promise<InstallationSettings> {
  if (!isTauri() && !isServer()) return { showRepository: false }
  return rpc<InstallationSettings>('installation_settings')
}
