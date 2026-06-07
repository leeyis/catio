import { createContext, useContext, useState } from 'react'
import i18n from '../i18n'

export type Lang = 'zh' | 'en'

interface LangCtx {
  lang: Lang
  setLang: (l: Lang) => void
}

const Ctx = createContext<LangCtx>({ lang: 'zh', setLang: () => {} })

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>((i18n.language as Lang) || 'zh')

  function setLang(l: Lang) {
    setLangState(l)
    i18n.changeLanguage(l)
    if (typeof localStorage !== 'undefined') localStorage.setItem('catio-lang', l)
    document.documentElement.lang = l
  }

  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>
}

export function useLang() {
  return useContext(Ctx)
}
