import { createContext, useContext } from 'react'
import { DATA } from '../services'
import type { CatioData } from '../services/types'

const Ctx = createContext<CatioData>(DATA)

export function DataProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={DATA}>{children}</Ctx.Provider>
}

export function useData() { return useContext(Ctx) }
