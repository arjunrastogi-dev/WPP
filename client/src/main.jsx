import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { bootTheme } from './components/ThemeToggle.jsx'

// Before the first paint, so a dark-mode user never sees a white flash.
bootTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
