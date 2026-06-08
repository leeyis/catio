import type { CSSProperties } from 'react'

interface BrandMarkProps {
  /** Rendered width & height in px (square). */
  size?: number
  className?: string
  style?: CSSProperties
}

/**
 * Catio brand mark — the cream-cat-with-terminal-cursor-mouth logo, matching the
 * app/taskbar icon (src-tauri/icons/catio-source.svg). Self-contained SVG: the
 * squircle fills the box, so it replaces the old `.logo-mark` div directly.
 * Uses `var(--accent-primary)` for the squircle + facial cutouts so the mark
 * follows the active theme accent.
 */
export function BrandMark({ size = 26, className, style }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className}
      style={{ display: 'block', flex: 'none', ...style }}
      aria-hidden="true"
    >
      <rect x="0" y="0" width="256" height="256" rx="60" fill="var(--accent-primary)" />
      {/* scale the cat up to fill the full-bleed squircle */}
      <g transform="translate(128 138) scale(1.2) translate(-128 -138)">
        <g fill="#FFF7ED" stroke="#FFF7ED" strokeWidth="16" strokeLinejoin="round">
          <path d="M88 100 L94 76 L118 93 Z" />
          <path d="M168 100 L162 76 L138 93 Z" />
        </g>
        <circle cx="128" cy="138" r="58" fill="#FFF7ED" />
        {/* eyes + mouth cut out in the accent (squircle) colour */}
        <circle cx="109" cy="131" r="8" fill="var(--accent-primary)" />
        <circle cx="147" cy="131" r="8" fill="var(--accent-primary)" />
        <circle cx="93" cy="153" r="7.5" fill="#FB9BC0" opacity="0.78" />
        <circle cx="163" cy="153" r="7.5" fill="#FB9BC0" opacity="0.78" />
        <rect x="118" y="153" width="20" height="9" rx="4.5" fill="var(--accent-primary)" />
      </g>
    </svg>
  )
}
