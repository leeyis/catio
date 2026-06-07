import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './i18n'
import { LanguageProvider } from './state/LanguageContext'
import { DataProvider } from './state/DataContext'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider><DataProvider><App /></DataProvider></LanguageProvider></React.StrictMode>)
