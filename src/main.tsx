import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getPg } from './modules/storage/pg'

// Open the database (and run the one-time Dexie migration) while the UI
// renders, so the first panel query isn't also paying the startup cost.
getPg().catch((err) => console.error('Could not open the local PostgreSQL database:', err))

// Receipts and claims exist only on this device, so ask the browser not to
// evict them when disk space runs low ("best-effort" storage can be
// cleared without warning). Seen in the pre-submission audit: receipt
// files vanished from OPFS in a test browser while their records stayed.
// The browser may decline; nothing else depends on the answer.
navigator.storage?.persist?.().catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
