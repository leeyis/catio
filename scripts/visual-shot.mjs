// Visual-verification screenshots of the automation panels (browser mock data).
// Usage: npm run dev (vite) then `node scripts/visual-shot.mjs`
import { chromium } from 'playwright-core'

const SHOTS = [
  ['tasks', '定时任务', 'Scheduled Tasks'],
  ['skills', '技能', 'Skills'],
  ['mcp', 'MCP 连接', 'MCP Connections'],
  ['history', '历史', 'History'],
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } })
await page.goto('http://localhost:1420', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

for (const [name, zh, en] of SHOTS) {
  const loc = page.locator(`button[title="${zh}"], button[title="${en}"]`).first()
  const visible = await loc.count().then(n => n > 0)
  if (visible) { await loc.click() } else { console.log(`rail not found for ${name}`) }
  await page.waitForTimeout(900)
  await page.screenshot({ path: `/tmp/catio-visual-${name}.png` })
  console.log(`saved /tmp/catio-visual-${name}.png`)
}

await browser.close()
console.log('done')
