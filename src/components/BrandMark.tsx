import { useId, type CSSProperties } from 'react'

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
 *
 * Colours are FIXED literals taken straight from the app icon (indigo gradient
 * #6366F1 → #4338CA for the squircle, #4338CA for the facial cutouts). The mark
 * deliberately does NOT follow the theme accent: `fill="var(--accent-primary)"`
 * inside SVG attributes renders inconsistently across WebView engines (WKWebView
 * on macOS vs WebView2 on Windows), so the mark stayed cream-locked on Windows
 * while shifting hue on macOS. Fixed colours keep it identical everywhere and in
 * sync with the desktop icon.
 */
export function BrandMark({ size = 26, className, style }: BrandMarkProps) {
  // Unique per instance: multiple BrandMarks render at once, and a shared
  // gradient id would break when the first instance unmounts.
  const gradId = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className}
      style={{ display: 'block', flex: 'none', ...style }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366F1" />
          <stop offset="1" stopColor="#4338CA" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="256" height="256" rx="60" fill={`url(#${gradId})`} />
      {/* scale the cat up to fill the full-bleed squircle */}
      <g transform="translate(128 138) scale(1.2) translate(-128 -138)">
        <g fill="#FFF7ED" stroke="#FFF7ED" strokeWidth="16" strokeLinejoin="round">
          <path d="M88 100 L94 76 L118 93 Z" />
          <path d="M168 100 L162 76 L138 93 Z" />
        </g>
        <circle cx="128" cy="138" r="58" fill="#FFF7ED" />
        {/* eyes + mouth in the deep indigo (matches the app icon) */}
        <circle cx="109" cy="131" r="8" fill="#4338CA" />
        <circle cx="147" cy="131" r="8" fill="#4338CA" />
        <circle cx="93" cy="153" r="7.5" fill="#FB9BC0" opacity="0.78" />
        <circle cx="163" cy="153" r="7.5" fill="#FB9BC0" opacity="0.78" />
        <rect x="118" y="153" width="20" height="9" rx="4.5" fill="#4338CA" />
      </g>
    </svg>
  )
}
