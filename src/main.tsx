import './polyfills'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './i18n'
import { LanguageProvider } from './state/LanguageContext'
import { DataProvider } from './state/DataContext'
import { ServerAuthGate } from './components/auth/ServerAuthGate'
import { RuntimeErrorBoundary } from './components/RuntimeErrorBoundary'
// ServerAuthGate gates the browser deploy behind login (M2). In the desktop app and in
// dev/test it renders children straight through, so nothing changes there.
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><RuntimeErrorBoundary><LanguageProvider><ServerAuthGate><DataProvider><App /></DataProvider></ServerAuthGate></LanguageProvider></RuntimeErrorBoundary></React.StrictMode>)
