// The offline web build's entry: the shared UI with the web platform, built into one HTML file (vite.config.ts).
import { App } from '@dialect/ui'
import '@dialect/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './web.css'
import { webPlatform } from './webPlatform'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={webPlatform} />
  </StrictMode>
)
