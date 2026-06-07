import { useEffect } from 'react'
import type { Theme } from './useTweaks'

// Cycles through dawn → amber → grove → dawn
// Matches blob15 TitleBar onToggleTheme logic:
//   theme_ === 'dawn' ? 'amber' : theme_ === 'amber' ? 'grove' : 'dawn'
export function nextTheme(t: Theme): Theme {
  if (t === 'dawn') return 'amber'
  if (t === 'amber') return 'grove'
  return 'dawn'
}

// Applies theme side-effects: data-theme attribute, --panel-w CSS variable,
// and localStorage persistence. No EDITMODE host protocol.
export function useApplyTheme(theme: Theme, panelW: number): void {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.setProperty('--panel-w', panelW + 'px')
    localStorage.setItem('catio-theme', theme)
  }, [theme, panelW])
}
