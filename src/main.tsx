import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getPg } from './modules/storage/pg'

// Open the database (and run the one-time Dexie migration) while the UI
// renders, so the first panel query isn't also paying the startup cost.
getPg().catch((err) => console.error('Could not open the local PostgreSQL database:', err))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
