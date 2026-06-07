// Usage: node scripts/shoot.mjs <url> <outPng> [viewport]
// Screenshots <url> to <outPng> using the gstack headless browse binary.
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
const B = path.join(os.homedir(), '.claude/skills/gstack/browse/dist/browse')
const [, , url, out, vp = '1440x900'] = process.argv
if (!url || !out) { console.error('usage: node scripts/shoot.mjs <url> <outPng> [WxH]'); process.exit(2) }
if (!fs.existsSync(B)) { console.error('browse binary not found at ' + B); process.exit(3) }
execFileSync(B, ['viewport', vp], { stdio: 'ignore' })
execFileSync(B, ['goto', url], { stdio: 'ignore' })
try { execFileSync(B, ['wait', '--networkidle'], { stdio: 'ignore' }) } catch {}
execFileSync(B, ['screenshot', path.resolve(out)], { stdio: 'inherit' })
console.log('shot ' + url + ' -> ' + out)
