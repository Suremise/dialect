// Small inline SVG icons (16 px, currentColor): no icon font to inline or allow in the CSP.
import type { ReactNode } from 'react'

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const OpenIcon = () => (
  <Icon>
    <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" />
    <path d="M1.5 6.5h13" />
  </Icon>
)

export const PasteIcon = () => (
  <Icon>
    <rect x="3" y="2.5" width="10" height="12" rx="1" />
    <path d="M6 2.5v-1h4v1M5.5 7h5M5.5 9.5h5M5.5 12h3" />
  </Icon>
)

export const SaveIcon = () => (
  <Icon>
    <path d="M8 1.5v8.5M4.5 6.5 8 10l3.5-3.5M2 11.5v3h12v-3" />
  </Icon>
)

export const CopyIcon = () => (
  <Icon>
    <rect x="5" y="5" width="9" height="9.5" rx="1" />
    <path d="M11 5V2.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
  </Icon>
)

export const ThemeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
  </Icon>
)

export const ErrorIcon = () => (
  <Icon className="icon-error">
    <circle cx="8" cy="8" r="6.5" />
    <path d="m5.5 5.5 5 5m0-5-5 5" />
  </Icon>
)

export const WarningIcon = () => (
  <Icon className="icon-warning">
    <path d="M8 1.8 15 14H1z" />
    <path d="M8 6v4M8 12v.2" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon className="icon-ok">
    <path d="m3 8.5 3 3 7-7" />
  </Icon>
)
