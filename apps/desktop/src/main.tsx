// The desktop app's frontend: the shared UI with the desktop platform, served by Tauri from dist/ (vite.config.ts).
import { App } from '@dialect/ui'
import '@dialect/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { desktopPlatform } from './desktopPlatform'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={desktopPlatform} />
  </StrictMode>
)
