import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { App } from './App'

const rootEl = document.getElementById('app')
if (!rootEl) throw new Error('#app not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
