import fs from 'node:fs'
import path from 'node:path'
const HTML = 'ref-ui/Catio (standalone).html'
const h = fs.readFileSync(HTML, 'utf8')

// 1) fonts
const fontsDir = 'src/assets/fonts'
fs.mkdirSync(fontsDir, { recursive: true })
const re = /"([0-9a-f-]{36})":\{"mime":"font\/woff2","compressed":(true|false),"data":"([A-Za-z0-9+/=]+)"/g
let m, count = 0
while ((m = re.exec(h))) {
  const [, uuid, , data] = m
  fs.writeFileSync(path.join(fontsDir, uuid + '.woff2'), Buffer.from(data, 'base64'))
  count++
}
if (count !== 13) throw new Error(`expected 13 fonts, got ${count}`)

// 2) CSS: from first @font-face to next unescaped quote
const at = h.indexOf('@font-face')
let i = at, buf = []
const BS = '\\'
while (i < h.length) {
  const ch = h[i]
  if (ch === BS) { buf.push(h[i] + h[i + 1]); i += 2; continue }
  if (ch === '"') break
  buf.push(ch); i++
}
const decoded = JSON.parse('"' + buf.join('') + '"')
// The decoded string spans the whole embedded HTML; trim at </style> to get only the CSS
const styleEnd = decoded.indexOf('</style>')
const css = styleEnd !== -1 ? decoded.slice(0, styleEnd) : decoded
const fixed = css.replace(/url\("([0-9a-f-]{36})"\)/g, 'url("/src/assets/fonts/$1.woff2")')
fs.writeFileSync('src/styles/tokens.css', fixed)
console.log(`extracted ${count} fonts, tokens.css ${fixed.length} chars`)
