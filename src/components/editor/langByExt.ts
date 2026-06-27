/* Map a remote file name to a CodeMirror language extension for syntax
 * highlighting. Returns null for unknown types (plain text, still editable).
 *
 * Static imports keep this simple; the language packages are small and Vite
 * tree-shakes unused grammars per build. */
import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { properties } from '@codemirror/legacy-modes/mode/properties'

/** Human label for the editor status bar (shows the detected language). */
export interface DetectedLang {
  ext: Extension
  label: string
}

const shellLang = () => StreamLanguage.define(shell)

/** Special-case whole filenames (no extension, or fixed names). Lowercased key. */
const BY_NAME: Record<string, () => DetectedLang> = {
  dockerfile: () => ({ ext: StreamLanguage.define(dockerFile), label: 'Dockerfile' }),
  makefile: () => ({ ext: shellLang(), label: 'Makefile' }),
  '.bashrc': () => ({ ext: shellLang(), label: 'Shell' }),
  '.bash_profile': () => ({ ext: shellLang(), label: 'Shell' }),
  '.zshrc': () => ({ ext: shellLang(), label: 'Shell' }),
  '.profile': () => ({ ext: shellLang(), label: 'Shell' }),
  '.env': () => ({ ext: StreamLanguage.define(properties), label: 'Properties' }),
  'nginx.conf': () => ({ ext: StreamLanguage.define(nginx), label: 'Nginx' }),
}

const BY_EXT: Record<string, () => DetectedLang> = {
  json: () => ({ ext: json(), label: 'JSON' }),
  jsonc: () => ({ ext: json(), label: 'JSON' }),
  yaml: () => ({ ext: yaml(), label: 'YAML' }),
  yml: () => ({ ext: yaml(), label: 'YAML' }),
  js: () => ({ ext: javascript(), label: 'JavaScript' }),
  cjs: () => ({ ext: javascript(), label: 'JavaScript' }),
  mjs: () => ({ ext: javascript(), label: 'JavaScript' }),
  jsx: () => ({ ext: javascript({ jsx: true }), label: 'JSX' }),
  ts: () => ({ ext: javascript({ typescript: true }), label: 'TypeScript' }),
  tsx: () => ({ ext: javascript({ typescript: true, jsx: true }), label: 'TSX' }),
  py: () => ({ ext: python(), label: 'Python' }),
  html: () => ({ ext: html(), label: 'HTML' }),
  htm: () => ({ ext: html(), label: 'HTML' }),
  vue: () => ({ ext: html(), label: 'HTML' }),
  css: () => ({ ext: css(), label: 'CSS' }),
  scss: () => ({ ext: css(), label: 'CSS' }),
  less: () => ({ ext: css(), label: 'CSS' }),
  md: () => ({ ext: markdown(), label: 'Markdown' }),
  markdown: () => ({ ext: markdown(), label: 'Markdown' }),
  xml: () => ({ ext: xml(), label: 'XML' }),
  svg: () => ({ ext: xml(), label: 'XML' }),
  rs: () => ({ ext: rust(), label: 'Rust' }),
  sql: () => ({ ext: sql(), label: 'SQL' }),
  sh: () => ({ ext: shellLang(), label: 'Shell' }),
  bash: () => ({ ext: shellLang(), label: 'Shell' }),
  zsh: () => ({ ext: shellLang(), label: 'Shell' }),
  toml: () => ({ ext: StreamLanguage.define(toml), label: 'TOML' }),
  ini: () => ({ ext: StreamLanguage.define(properties), label: 'INI' }),
  conf: () => ({ ext: StreamLanguage.define(properties), label: 'Config' }),
  properties: () => ({ ext: StreamLanguage.define(properties), label: 'Properties' }),
}

/** Detect a language for a remote file path. Returns null for unknown/plain text. */
export function detectLang(path: string): DetectedLang | null {
  const name = (path.split(/[/\\]/).pop() || '').toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]()
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1)
    if (BY_EXT[ext]) return BY_EXT[ext]()
  }
  return null
}
