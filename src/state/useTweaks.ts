import { useState } from 'react'

export type Theme = 'dawn' | 'amber' | 'grove'

export interface Tweaks {
  theme: Theme
  density: 'compact' | 'comfortable'
  aiForm: 'side' | 'floating' | 'bar'
  panelW: number
  vaultMode: 'grid' | 'list' | 'tree'
}

export const TWEAK_DEFAULTS: Tweaks = {
  theme: 'dawn',
  density: 'comfortable',
  aiForm: 'side',
  panelW: 340,
  vaultMode: 'grid',
}

export function useTweaks(initial: Tweaks = TWEAK_DEFAULTS) {
  const [t, setT] = useState<Tweaks>(initial)
  function setTweak<K extends keyof Tweaks>(k: K, v: Tweaks[K]) {
    setT(s => ({ ...s, [k]: v }))
  }
  return [t, setTweak] as const
}
