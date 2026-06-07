# Catio UI 外壳 v1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ref-ui/Catio (standalone).html` 解包出的 React 原型 1:1 移植为可在 Windows/macOS 运行的 Tauri v2 + React 18 + TypeScript + Vite 桌面应用，mock 数据跑通、像素级复刻、并建立 `services/` 数据接缝层供后续后端子项目接入。

**Architecture:** 忠实移植路线（spec §12 路线 A）。设计令牌 CSS 与组件内联样式逐字搬运；每个解包 `blobN.txt` → 一个 TS 模块，`window.X` 全局改为 ES `import/export`，`window.DATA` 改为 `useData()`。所有数据经 `services/` 层（现返回 mock，未来换 Tauri `invoke`）。

**Tech Stack:** Tauri v2、React 18、TypeScript(strict)、Vite、Vitest + React Testing Library（逻辑与渲染冒烟测试）、gstack browse 截图（像素验收）。

参照源码（已在仓库）：`ref-ui/_extract/blob3-16.txt`（组件）、`styles.css`（设计令牌）、`blob10.txt`（mock 数据）、`ref-ui/Catio (standalone).html`（内嵌字体 + 资源清单）。

---

## 测试哲学（本计划的"测试"含义）

这是一次**逐字视觉移植**，标准单测金字塔不完全适用。本计划三层验证：

1. **纯逻辑单测（Vitest）** — 真正的 TDD：`services` API 形状、`buildSidebarTree`（隧道嵌套）、`highlightSQL`、主题 reducer。先写失败测试。
2. **渲染冒烟测试（Vitest + RTL）** — 组件在 mock 数据下能挂载不抛错。"失败测试"= 组件文件尚不存在 → import 失败 → 红。
3. **像素验收（browse 截图）** — 里程碑处用 browse 截运行中的 React 应用，与原型对应屏逐张目视对比（必要时 `scripts/diff.mjs` 跑 pixelmatch）。

## Port 任务怎么做（统一转换规则，只定义一次）

每个 port 任务给出：**源 blob → 目标文件 → 导出 → 需要的 import**。按以下规则机械转换，**JSX / className / 内联 style 对象 / hooks / 动画类逐字不动**：

- **T1** `Object.assign(window, { A, B })` → 删除该行，改为对各函数加 `export`。
- **T2** 组件引用的其他全局（`<Icon …>`、`<Btn …>` 等原 window 全局）→ 文件顶部加 `import { Icon } from '../Icon'` 等。
- **T3** `const D = window.DATA` → 组件内 `const D = useData()`（来自 `state/DataContext`）；纯函数（如 `buildSidebarTree`、`highlightSQL`）改为参数传入，不读全局。
- **T4** `style={{ WebkitAppRegion: 'drag' }}` → `data-tauri-drag-region` 属性；`'no-drag'` 区域删除该样式（默认即不可拖）。
- **T5** 给组件 props 加 TS 类型（来自 `services/types.ts`）；事件处理器参数补类型。
- **T6** 文件首行加 `/* ported from ref-ui/_extract/blobN.txt — verbatim per plan T1-T7 */`。
- **T7（i18n 外置 UI 文案，spec §14）** 组件内**界面**中文字面量 → `t('ns.key')`（`useTranslation` 来自 react-i18next）；同时在 `src/i18n/zh.json` 写入**原中文原文**、`src/i18n/en.json` 写入英文译文。带变量用插值 `t('ns.key', { n })`。**演示/mock 文本不动**（AI 对话、连接名、示例 SQL、片段描述等占位数据保持原样）。命名空间按组件区域：`common/shell/home/vault/settings/panels/workbench/dbviews/modals/auth`。默认语言 zh，故默认渲染与原型逐字一致。

**worked example**（shell `ConnRow` 片段）：

```
// 原型 blob16:
function ConnRow({ conn, active, onOpen, onDetail, nested }) { ...
  <span ...>{nested ? (window.DATA.engineMeta[conn.engine] || {}).label : conn.sub}</span>
Object.assign(window, { TitleBar, Sidebar, IconRail, ConnRow });

// 移植后 components/shell/Sidebar.tsx:
import { Icon, IconBtn, StatusDot, ConnGlyph, Segmented } from '../atoms'
import { useData } from '../../state/DataContext'
import type { Connection } from '../../services/types'
function ConnRow({ conn, active, onOpen, onDetail, nested }: ConnRowProps) {
  const D = useData(); ...
  <span ...>{nested ? (D.engineMeta[conn.engine] || {}).label : conn.sub}</span>
}
export { TitleBar, Sidebar, IconRail, ConnRow }
```

---

## 文件结构

```
catio/
├─ src-tauri/{Cargo.toml, tauri.conf.json, src/main.rs, src/lib.rs, build.rs, icons/}
├─ index.html, vite.config.ts, tsconfig.json, package.json
├─ scripts/{extract-assets.mjs, shoot.mjs, diff.mjs}
├─ src/
│  ├─ main.tsx, App.tsx
│  ├─ styles/tokens.css
│  ├─ assets/fonts/<uuid>.woff2 (×13)
│  ├─ components/{Icon.tsx, atoms.tsx, shell/, views/, workbench/, dbviews/, panels/, modals/, auth/}
│  ├─ services/{types.ts, mockData.ts, index.ts}
│  └─ state/{DataContext.tsx, ThemeContext.tsx, useTweaks.ts}
└─ tests/ (vitest 配置在 vite.config.ts)
```

每个目录一个 `index.ts` re-export，便于 App 聚合 import。

---

## Task 1: Scaffold Tauri v2 + React + TS + Vite

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src-tauri/{Cargo.toml, tauri.conf.json, build.rs, src/main.rs, src/lib.rs}`

- [ ] **Step 1: 用脚手架创建项目骨架**

Run（在 `I:/ai-projects/catio`，目录已有 docs/ref-ui，故用当前目录初始化而非新建子目录）:
```bash
npm create tauri-app@latest . -- --template react-ts --manager npm --identifier io.catio.app
```
若工具拒绝非空目录，手动创建以下文件（见后续步骤），不要覆盖 `docs/`、`ref-ui/`。

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "catio",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "tauri": "tauri",
    "test": "vitest run",
    "test:watch": "vitest",
    "extract-assets": "node scripts/extract-assets.mjs"
  },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "@tauri-apps/api": "^2" },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0",
    "jsdom": "^24.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.4.0",
    "pixelmatch": "^6.0.0",
    "pngjs": "^7.0.0"
  }
}
```

- [ ] **Step 3: 写 `vite.config.ts`（含 Vitest 配置，固定端口 1420 对齐 Tauri）**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { environment: 'jsdom', globals: true, setupFiles: './tests/setup.ts' },
})
```

- [ ] **Step 4: 写 `tsconfig.json`（strict）**

```json
{
  "compilerOptions": {
    "target": "ES2020", "useDefineForClassFields": true, "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext", "skipLibCheck": true, "moduleResolution": "bundler",
    "resolveJsonModule": true, "isolatedModules": true, "noEmit": true,
    "jsx": "react-jsx", "strict": true, "noUnusedLocals": true, "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true, "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: `tests/setup.ts` + 占位 App**

`tests/setup.ts`:
```ts
import '@testing-library/jest-dom'
```
`src/App.tsx`:
```tsx
export default function App() { return <div className="win">Catio</div> }
```
`src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
```
`index.html`:
```html
<!doctype html><html><head><meta charset="UTF-8" /><title>Catio</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
先建空 `src/styles/tokens.css`（Task 3 填充）。

- [ ] **Step 6: 配 `src-tauri/tauri.conf.json` 窗口（Win+mac 无边框）**

关键字段：
```json
{
  "productName": "Catio", "identifier": "io.catio.app",
  "build": { "frontendDist": "../dist", "devUrl": "http://localhost:1420",
             "beforeDevCommand": "npm run dev", "beforeBuildCommand": "npm run build" },
  "app": { "windows": [{
    "title": "Catio", "width": 1280, "height": 820, "minWidth": 980, "minHeight": 640,
    "decorations": false, "titleBarStyle": "Overlay", "transparent": false
  }] }
}
```
（`titleBarStyle: Overlay` 在 macOS 给红绿灯留位；Windows 上忽略。）

- [ ] **Step 7: 安装并验证启动**

Run: `npm install && npm run tauri dev`
Expected: 桌面窗口弹出，显示 "Catio"，无边框。`Ctrl+C` 退出。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold Tauri v2 + React + TS + Vite"
```

---

## Task 2: 资源提取脚本（字体 + 设计令牌 CSS）

**Files:**
- Create: `scripts/extract-assets.mjs`
- Create: `src/styles/tokens.css`, `src/assets/fonts/<uuid>.woff2` (×13)

- [ ] **Step 1: 写 `scripts/extract-assets.mjs`**

从 standalone HTML 提取 13 个 woff2 与设计令牌 CSS（资源清单结构已核实：`"uuid":{"mime","compressed":false,"data":base64}`；CSS 是 HTML 末尾一段转义 JS 字符串，从 `@font-face` 起到下一处未转义 `"` 止）：

```js
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
const at = h.indexOf('@font-face', 1700000 - 1) // manifest sits ~1.73MB in; scan from there
let i = at, buf = []
const BS = '\\'
while (i < h.length) {
  const ch = h[i]
  if (ch === BS) { buf.push(h[i] + h[i + 1]); i += 2; continue }
  if (ch === '"') break
  buf.push(ch); i++
}
// unescape \n \" \\ \uXXXX
const css = JSON.parse('"' + buf.join('') + '"')
// rewrite @font-face urls: url("<uuid>") -> url("/src/assets/fonts/<uuid>.woff2")
const fixed = css.replace(/url\("([0-9a-f-]{36})"\)/g, 'url("/src/assets/fonts/$1.woff2")')
fs.writeFileSync('src/styles/tokens.css', fixed)
console.log(`extracted ${count} fonts, tokens.css ${fixed.length} chars`)
```

- [ ] **Step 2: 运行脚本**

Run: `npm run extract-assets`
Expected 输出: `extracted 13 fonts, tokens.css ~32800 chars`

- [ ] **Step 3: 验证 CSS 含三主题与字体引用**

Run: `node -e "const c=require('fs').readFileSync('src/styles/tokens.css','utf8'); ['[data-theme=\"dawn\"]','[data-theme=\"amber\"]','[data-theme=\"grove\"]','--accent-primary','/src/assets/fonts/'].forEach(t=>{if(!c.includes(t))throw new Error('missing '+t)}); console.log('css ok')"`
Expected: `css ok`

- [ ] **Step 4: 目视确认字体生效**

Run: `npm run dev`，浏览器开 `http://localhost:1420`，DevTools 确认 Inter/Geist Mono 加载无 404。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: extract embedded fonts and design-token CSS"
```

---

## Task 3: 数据类型 `services/types.ts`

**Files:** Create: `src/services/types.ts`

- [ ] **Step 1: 依据 `blob10.txt` mock 形状定义类型**

```ts
export type ConnKind = 'host' | 'db'
export type ConnStatus = 'up' | 'idle' | 'down'
export interface Group { id: string; name: string; color: string }
export interface Connection {
  id: string; group: string; kind: ConnKind; name: string; sub: string; icon: string;
  status: ConnStatus; tags?: string[]; lastUsed?: string;
  proto?: 'ssh' | 'telnet' | 'local'; os?: string; engine?: string;
  tunnel?: string; stats?: { cpu: number; mem: number; up: string };
}
export interface EngineMeta { label: string; short: string; color: string }
export interface OsMeta { label: string; color: string }
export interface TableCol { name: string; type: string; pk?: boolean; fk?: boolean; icon: string }
export interface StructColumn { name: string; type: string; nullable: boolean; default: string | null; key: 'PK'|'FK'|'UNI'|''; extra: string }
export interface StructIndex { name: string; cols: string; unique: boolean; method: string }
export interface StructFk { col: string; ref: string; onDelete: string; onUpdate: string }
export interface TableStructure { comment: string; columns: StructColumn[]; indexes: StructIndex[]; fks: StructFk[] }
export interface ErTable { name: string; x: number; y: number }
export interface ErRelation { from: string; fromCol: string; to: string; toCol: string }
export interface Recent { id: string; kind: ConnKind; ref: string; title: string; detail: string; when: string; icon: string; accent: string }
export interface Snippet { id: string; scope: string; desc: string; icon: string; code: string }
export interface Tunnel { id: string; type: 'L'|'R'|'D'; label: string; via: string; local: string; remote: string; status: ConnStatus; bytes: string; engine?: string }
export interface HistoryItem { id: string; kind: 'sql'|'shell'; target: string; text: string; when: string; dur: string }
export interface TermLine { t: 'sys'|'prompt'|'out'|'err'; s?: string; host?: string; path?: string; cmd?: string; cursor?: boolean }
export interface SftpItem { name: string; type: 'up'|'dir'|'file'; size?: string; mod?: string }
// AI thread / quick actions / monitor / multiExec / automation：照 blob10 形状补全（agent step、snippet、gpus 等）
export interface Tab { id: string; kind: 'terminal'|'sql'; connId: string; title: string }
export interface CatioData { /* 见 window.DATA 的全部键 */ groups: Group[]; connections: Connection[]; engineMeta: Record<string, EngineMeta>; /* … */ byId: Record<string, Connection> }
```
（AI/monitor/multiExec/automation 等子结构按 `blob10.txt` 字段一一补全，不留 `any`。）

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat: data model types"`

---

## Task 4: Mock 数据 `services/mockData.ts`（移植 blob10）

**Files:** Create: `src/services/mockData.ts`; Test: `tests/mockData.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { DATA } from '../src/services/mockData'
describe('mockData', () => {
  it('has 13 connections and byId index', () => {
    expect(DATA.connections.length).toBe(13)
    expect(DATA.byId['d-orders'].engine).toBe('postgres')
  })
  it('orders rows are 120', () => { expect(DATA.ordersRows.length).toBe(120) })
})
```

- [ ] **Step 2: 运行 → 失败** Run: `npm test -- mockData` Expected: FAIL（模块不存在）

- [ ] **Step 3: 移植 blob10 为 TS 模块**

把 `ref-ui/_extract/blob10.txt` 的 IIFE 内部内容搬入，去掉 `(function(){…})()` 包裹与 `window.DATA =`，改为：`export const DATA: CatioData = { …同一对象… }`。`makeRows`/`series` 等保留为模块内函数。给数组字面量按需 `as Connection[]` 等断言以满足类型。

- [ ] **Step 4: 运行 → 通过** Run: `npm test -- mockData` Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port mock data to typed module"`

---

## Task 5: 数据接缝 `services/index.ts` + DataContext

**Files:** Create: `src/services/index.ts`, `src/state/DataContext.tsx`; Test: `tests/services.test.ts`

- [ ] **Step 1: 写失败测试（锁定 async 契约）**

```ts
import { describe, it, expect } from 'vitest'
import * as svc from '../src/services'
describe('services seam', () => {
  it('listConnections returns the vault', async () => {
    const c = await svc.listConnections()
    expect(c.find(x => x.id === 'd-orders')).toBeTruthy()
  })
  it('runQuery returns rows + columns', async () => {
    const r = await svc.runQuery('d-orders', 'select 1')
    expect(r.columns.length).toBeGreaterThan(0)
    expect(Array.isArray(r.rows)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行 → 失败** Run: `npm test -- services` Expected: FAIL

- [ ] **Step 3: 实现 services（内部返回 mock，签名为 async）**

```ts
import { DATA } from './mockData'
import type { Connection } from './types'
export interface QueryResult { columns: typeof DATA.ordersColumns; rows: typeof DATA.ordersRows }
export async function listConnections(): Promise<Connection[]> { return DATA.connections }
export async function runQuery(_connId: string, _sql: string): Promise<QueryResult> {
  return { columns: DATA.ordersColumns, rows: DATA.ordersRows }
}
// 占位：终端缓冲、SFTP、监控、隧道、schema 等，全部 async，返回对应 mock
export async function getSchema(_connId: string) { return DATA.schema }
export async function getTermBuffer(_connId: string) { return DATA.termLines }
export { DATA } // 同步只读 mock，供 DataContext
```

- [ ] **Step 4: `DataContext.tsx` 提供 `useData()`**

```tsx
import { createContext, useContext } from 'react'
import { DATA } from '../services'
import type { CatioData } from '../services/types'
const Ctx = createContext<CatioData>(DATA)
export function DataProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={DATA}>{children}</Ctx.Provider>
}
export function useData() { return useContext(Ctx) }
```

- [ ] **Step 5: 运行 → 通过** Run: `npm test -- services` Expected: PASS

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: services seam + DataContext"`

---

## Task 6: 主题与偏好 `state/ThemeContext.tsx` + `useTweaks.ts`

**Files:** Create: `src/state/useTweaks.ts`, `src/state/ThemeContext.tsx`; Test: `tests/theme.test.ts`

- [ ] **Step 1: 写失败测试（纯 reducer/逻辑）**

```ts
import { describe, it, expect } from 'vitest'
import { nextTheme } from '../src/state/ThemeContext'
describe('theme', () => {
  it('cycles dawn -> amber -> grove -> dawn', () => {
    expect(nextTheme('dawn')).toBe('amber')
    expect(nextTheme('amber')).toBe('grove')
    expect(nextTheme('grove')).toBe('dawn')
  })
})
```

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 实现 `useTweaks`（从 blob13 仅保留 localStorage 偏好，剔除 host postMessage 协议与 TweaksPanel UI）**

```ts
import { useState, useEffect } from 'react'
export type Theme = 'dawn' | 'amber' | 'grove'
export interface Tweaks { theme: Theme; density: 'compact'|'comfortable'; aiForm: 'side'; panelW: number; vaultMode: 'grid'|'list'|'tree' }
export const TWEAK_DEFAULTS: Tweaks = { theme: 'dawn', density: 'comfortable', aiForm: 'side', panelW: 340, vaultMode: 'grid' }
export function useTweaks(initial: Tweaks = TWEAK_DEFAULTS) {
  const [t, setT] = useState<Tweaks>(initial)
  function setTweak<K extends keyof Tweaks>(k: K, v: Tweaks[K]) { setT(s => ({ ...s, [k]: v })) }
  return [t, setTweak] as const
}
```

- [ ] **Step 4: 实现 `ThemeContext`（`nextTheme` 纯函数 + 副作用写 `data-theme`/localStorage/`--panel-w`）**

逻辑照 blob15 App 的 theme `useEffect`：`document.documentElement.setAttribute('data-theme', theme)`、`style.setProperty('--panel-w', panelW+'px')`、`localStorage.setItem('catio-theme', theme)`。导出 `nextTheme(t: Theme): Theme`。

- [ ] **Step 5: 运行 → 通过** Expected: PASS

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: theme + preferences state (EDITMODE host protocol dropped)"`

---

## Task 6B: i18n 基建（spec §14）

**Files:** Create: `src/i18n/{index.ts, zh.json, en.json}`, `src/state/LanguageContext.tsx`; Modify: `src/main.tsx`(初始化 i18n + 包 LanguageProvider), `package.json`(加 i18next/react-i18next); Test: `tests/i18n.test.ts`

- [ ] **Step 1: 装依赖** `npm i i18next react-i18next`

- [ ] **Step 2: 写失败测试**

```ts
import i18n from '../src/i18n'
it('defaults to zh and switches to en', async () => {
  expect(i18n.language).toBe('zh')
  expect(i18n.t('common.newConnection')).toBe('新建连接')
  await i18n.changeLanguage('en')
  expect(i18n.t('common.newConnection')).toBe('New connection')
})
```

- [ ] **Step 3: 运行 → 失败** Expected: FAIL

- [ ] **Step 4: 实现 i18n**

`src/i18n/zh.json` / `en.json`：先放种子键（如 `common.newConnection`）；后续组件移植按 T7 增量补键。
`src/i18n/index.ts`:
```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import en from './en.json'
const saved = (typeof localStorage !== 'undefined' && localStorage.getItem('catio-lang')) || 'zh'
i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: saved, fallbackLng: 'zh', interpolation: { escapeValue: false },
})
export default i18n
```
`LanguageContext.tsx`：`useLang()` 返回 `{ lang, setLang }`；`setLang` 调 `i18n.changeLanguage`、写 `localStorage('catio-lang')`、设 `document.documentElement.lang`。
`main.tsx`：`import './i18n'` 并用 `<LanguageProvider>` 包裹 App（在 DataProvider 内外均可）。

- [ ] **Step 5: 运行 → 通过** Expected: PASS

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: i18n infrastructure (zh default, en switch)"`

> 此后所有含界面文案的组件移植任务（Task 9-15）按 **T7** 外置中文串到 zh.json/en.json。语言切换器在 Task 13(panels)或 Task 10(SettingsView) 内实现：Settings 加语言选择项。

---

## Task 7: 图标集 `components/Icon.tsx`（移植 blob8）

**Files:** Create: `src/components/Icon.tsx`; Test: `tests/icon.test.tsx`

- [ ] **Step 1: 写失败渲染测试**

```tsx
import { render } from '@testing-library/react'
import { Icon } from '../src/components/Icon'
it('renders a known icon as svg', () => {
  const { container } = render(<Icon name="server" size={16} />)
  expect(container.querySelector('svg')).toBeTruthy()
})
```

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob8（T1/T5/T6）** —— 把 lucide 子集逐字搬入，`export function Icon(...)`，props 加类型 `{ name: string; size?: number; style?: React.CSSProperties }`。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port Icon set"`

---

## Task 8: 原子组件 `components/atoms.tsx`（移植 blob3）

**Files:** Create: `src/components/atoms.tsx`; Test: `tests/atoms.test.tsx`

- [ ] **Step 1: 写失败冒烟测试** —— 渲染 `Btn`、`StatusDot`、`ConnGlyph`（传一个 mock connection）不抛错。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob3（T1/T2/T5/T6）** —— 导出 Btn/IconBtn/Toggle/Chip/IconBadge/StatusDot/ConnGlyph/Segmented/SectionHead；`import { Icon } from './Icon'`。`statusTones` 等若读 `window.DATA` 改为内部常量或 `useData()`。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port UI atoms"`

---

## Task 9: 应用外壳 `components/shell/`（移植 blob16）

**Files:** Create: `src/components/shell/Sidebar.tsx`(含 TitleBar/IconRail/ConnRow/buildSidebarTree), `src/components/shell/index.ts`; Test: `tests/sidebarTree.test.ts`

- [ ] **Step 1: 写失败测试（buildSidebarTree 纯逻辑）**

```ts
import { buildSidebarTree } from '../src/components/shell/Sidebar'
import { DATA } from '../src/services/mockData'
it('nests tunneled dbs under their bastion host', () => {
  const prod = DATA.connections.filter(c => c.group === 'prod')
  const tree = buildSidebarTree(prod, 'all')
  const bastion = tree.find(n => n.nested && n.host.id === 'h-bastion')
  expect(bastion).toBeTruthy()
  expect(bastion!.dbs.map(d => d.id)).toContain('d-orders')
})
```

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob16（T1-T6）** —— `buildSidebarTree(items, filter)` 改为纯函数（参数传入，不读 window）。TitleBar 的 `WebkitAppRegion:'drag'` → `data-tauri-drag-region`；窗口三键 onClick 暂留空（Task 16 接 Tauri）。导出全部 + `buildSidebarTree`。给 nested 节点类型 `{ nested: true; host: Connection; dbs: Connection[] } | { conn: Connection }`。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port app shell (titlebar/sidebar/rail)"`

---

## Task 10: 视图 `components/views/`（移植 blob4 + blob12）

**Files:** Create: `src/components/views/{HomeView,VaultView,SettingsView}.tsx`, `index.ts`; Test: `tests/views.test.tsx`

- [ ] **Step 1: 写失败冒烟测试** —— 用 `DataProvider` 包裹渲染 HomeView/VaultView/SettingsView，断言出现关键文案（如 "最近会话"、"服务器与数据库"）。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 HomeView+VaultView（blob4）、SettingsView（blob12）（T1-T7）** —— `window.DATA`→`useData()`；`Stat`/`SectionHead` 等子组件随文件保留或从 atoms import。SettingsView 的认证相关 props 先按原型签名保留（Task 14/15 接 App 状态）。**按 T7 外置界面中文到 zh/en.json**（home/vault/settings 命名空间）。**SettingsView 内新增语言选择项**（中文/English，调 `useLang().setLang`），样式与既有主题/密度偏好项一致。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port Home/Vault/Settings views"`

---

## Task 11: 数据库视图 `components/dbviews/`（移植 blob5 + blob6 + blob7 的 highlightSQL/SqlEditor/SqlConsole）

**Files:** Create: `src/components/dbviews/{SqlEditor,SqlConsole,StructureView,ERDiagram,DataGrid}.tsx`, `highlightSQL.ts`, `index.ts`; Test: `tests/highlightSQL.test.ts`, `tests/dbviews.test.tsx`

- [ ] **Step 1: 写失败测试（highlightSQL 纯函数 + 各视图冒烟）**

```ts
import { highlightSQL } from '../src/components/dbviews/highlightSQL'
it('wraps keywords in colored spans', () => {
  const out = highlightSQL('select * from orders')
  expect(out).toContain('var(--accent-primary)') // keyword color
  expect(out).toContain('orders')
})
```

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植** —— `highlightSQL`（blob7 顶部）抽成 `highlightSQL.ts` 纯函数；StructureView/ERDiagram（blob5）、DataGrid（blob6）、SqlEditor/SqlConsole（blob7）逐字搬。ERDiagram 用原型自带 SVG 画法（**不**引入 React Flow）；DataGrid 用原型自带滚动表（**不**引入 TanStack）。`window.DATA`→`useData()` 或 props。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port DB views (structure/ER/grid/sql editor)"`

---

## Task 12: 工作台 `components/workbench/`（移植 blob7 余下）

**Files:** Create: `src/components/workbench/{WorkbenchTabs,TerminalPane,DbWorkbench,SchemaBrowser}.tsx`, `index.ts`; Test: `tests/workbench.test.tsx`

- [ ] **Step 1: 写失败冒烟测试** —— 渲染 TerminalPane（mock conn）出现终端行文案；DbWorkbench 出现 schema 表名 "orders"。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob7 余下组件（T1-T6）** —— `import { highlightSQL, SqlEditor, … } from '../dbviews'`；终端的多机广播 `mxHosts`、选区 `selBar` 等本地状态原样保留；`window.DATA`→`useData()`。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port workbench (tabs/terminal/db workbench/schema browser)"`

---

## Task 13: 功能面板 `components/panels/`（移植 blob9）

**Files:** Create: `src/components/panels/{PanelShell,AIPanel,SftpPanel,MonitorPanel,TunnelsPanel,SnippetsPanel,HistoryPanel,DetailsPanel}.tsx`, `index.ts`; Test: `tests/panels.test.tsx`

- [ ] **Step 1: 写失败冒烟测试** —— 每个面板各渲染一次不抛错（AIPanel 传 mode='sql'、conn=mock；SnippetsPanel 传 snippets=DATA.snippets）。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob9（T1-T6）** —— `catio-ask-ai` 自定义窗口事件保留（AIPanel 仍可监听）；`AgentMessage` 等子组件随文件保留；`window.DATA`→`useData()`。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port function panels"`

---

## Task 14: 弹窗与认证 `components/modals/` + `components/auth/`（移植 blob11 + blob14）

**Files:** Create: `src/components/modals/NewConnectionModal.tsx`, `src/components/auth/AuthGate.tsx`(锁屏+首次运行), 各 `index.ts`; Test: `tests/auth.test.tsx`

- [ ] **Step 1: 写失败冒烟测试** —— NewConnectionModal 渲染出 "新建连接"；AuthGate 首次运行渲染出创建用户表单、锁屏态渲染出解锁入口。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob11（模态）、blob14（认证门禁）（T1-T6）** —— 认证仍用 localStorage 模拟（spec 非目标：不做真加密/哈希）；props 按原型签名（`onLogin`/`onCreateUser`/`users`/`ownerUser` 等）。

- [ ] **Step 4: 运行 → 通过** Expected: PASS

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port new-connection modal + auth gate (UI only)"`

---

## Task 15: 应用根 `App.tsx`（移植 blob15，聚合全部）

**Files:** Modify: `src/App.tsx`; Modify: `src/main.tsx`(包 Providers); Test: `tests/app.test.tsx`

- [ ] **Step 1: 写失败集成测试** —— 渲染 `<App/>`：默认 home 视图出现 hero；点 "进入工作台" 切到 workbench 出现标签栏；点主题键 `document.documentElement` 的 `data-theme` 改变。

- [ ] **Step 2: 运行 → 失败** Expected: FAIL

- [ ] **Step 3: 移植 blob15（T1-T6）** —— 全部 `window.X` 组件改 import；`useTweaks` 用 `state/useTweaks`（去掉 EDITMODE 注释块对 host 的依赖，保留 `TWEAK_DEFAULTS`）；theme `useEffect` 用 `ThemeContext` 逻辑；`window.DATA`→`useData()`。`main.tsx` 用 `<DataProvider>` 包裹。

- [ ] **Step 4: 运行 → 通过** Expected: PASS；并 `npx tsc --noEmit` 全绿。

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port app root, wire all components"`

---

## Task 16: Tauri 窗口装饰接线（Win + macOS）

**Files:** Modify: `src/components/shell/Sidebar.tsx`(TitleBar 三键), `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`

- [ ] **Step 1: TitleBar 三键接 Tauri 窗口 API**

```ts
import { getCurrentWindow } from '@tauri-apps/api/window'
const win = getCurrentWindow()
// 最小化: win.minimize()  最大化: win.toggleMaximize()  关闭: win.close()
```
保留原型三键 DOM 与样式，仅给 onClick 绑上述调用。

- [ ] **Step 2: macOS 隐藏自绘三键、给红绿灯留位**

用 `import { platform } from '@tauri-apps/plugin-os'`（或编译期 `cfg`）判断：mac 上隐藏右上自绘三键、品牌区左侧 padding 给红绿灯（约 72px）。`tauri.conf.json` 已设 `titleBarStyle: Overlay`。

- [ ] **Step 3: 启用 window/os 插件**

`Cargo.toml` 加 `tauri-plugin-os`；`lib.rs` `.plugin(tauri_plugin_os::init())`；`tauri.conf.json` capabilities 允许 `core:window:allow-minimize/toggle-maximize/close`。

- [ ] **Step 4: 验证（Windows）**

Run: `npm run tauri dev`；点最小化/最大化/关闭三键，行为正确；拖拽标题栏移动窗口（`data-tauri-drag-region` 生效）。

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: wire window controls for Windows + macOS"`

---

## Task 17: 截图工具与像素验收

**Files:** Create: `scripts/shoot.mjs`, `scripts/diff.mjs`

- [ ] **Step 1: 写 `scripts/shoot.mjs`（用 gstack browse 截某 URL）**

```js
// node scripts/shoot.mjs <url> <outPng> [viewport]
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
const B = path.join(os.homedir(), '.claude/skills/gstack/browse/dist/browse')
const [, , url, out, vp = '1440x900'] = process.argv
execFileSync(B, ['viewport', vp], { stdio: 'ignore' })
execFileSync(B, ['goto', url], { stdio: 'ignore' })
execFileSync(B, ['wait', '--networkidle'], { stdio: 'ignore' })
execFileSync(B, ['screenshot', out], { stdio: 'inherit' })
```

- [ ] **Step 2: 写 `scripts/diff.mjs`（pixelmatch 对比两 PNG，输出差异像素数）**

读两 PNG（pngjs）、`pixelmatch` 比较、打印差异比例与 diff 图路径。阈值建议 < 1%（字体抗锯齿允许微差）。

- [ ] **Step 3: 准备原型基准图**

原型已复制到 `ref-ui/_extract/catio.html`。截基准（Home/各主题/workbench 等）：
```bash
node scripts/shoot.mjs "file:///I:/ai-projects/catio/ref-ui/_extract/catio.html" ref-ui/_extract/base-home.png
```

- [ ] **Step 4: 截 React 应用同屏并对比**

```bash
npm run dev &   # localhost:1420
node scripts/shoot.mjs "http://localhost:1420" /tmp/app-home.png
node scripts/diff.mjs ref-ui/_extract/base-home.png /tmp/app-home.png
```
Expected: 差异 < 1%。用 Read 工具目视两图确认无可辨差异。

- [ ] **Step 5: Commit** `git add -A && git commit -m "chore: screenshot + pixel-diff harness"`

---

## Task 18: 全屏像素验收（所有视图 × 三主题）

**Files:** 无新增（按需微调样式以消除像素差）

- [ ] **Step 1: 逐屏对比清单**

对以下每屏，原型 vs 应用各截图 + diff + 目视：
- Home（dawn/amber/grove 各一）
- Workbench·终端（`#workbench-term`）
- Workbench·SQL+数据网格（`#workbench-sql`）
- Settings
- 右侧面板：AI / SFTP / 监控 / 隧道 / 片段 / 历史 / 详情
- 新建连接弹窗
- 锁屏 / 首次运行

原型用 hash 切屏需 reload（App 仅初始化读 hash）。应用侧用对应交互导航到同屏后再截。

- [ ] **Step 2: 修差**

每处可辨差异：定位到对应组件，核对 `ref-ui/_extract/blobN.txt` 原始内联 style/className，逐字补回。只改样式，不改结构/逻辑。每修一处单独 commit。

- [ ] **Step 3: 交互一致性核对**

手动走查（spec §11.3）：开/关/切标签、切面板、切主题、侧栏过滤+分组折叠、隧道嵌套展示、认证流程（首次运行→创建→锁定→解锁→隔离 vault）。行为须与原型一致。

- [ ] **Step 3B: i18n 核对（spec §14）**

默认 zh 各屏与原型像素一致；Settings 切到 English 后界面文案变英文、布局不崩（合理换行/省略可接受）、刷新后保持。扫描组件内残留未外置的界面中文字面量（演示/mock 文本除外）：`node -e` 或 grep 检查 `src/components` 下 .tsx 中作者书写的中文串是否都已走 `t(...)`。

- [ ] **Step 4: 最终 typecheck + 全测试**

Run: `npx tsc --noEmit && npm test`
Expected: 全绿。

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: pixel-perfect parity pass across all views and themes"`

---

## Self-Review（已执行）

- **Spec 覆盖**：§4 目录→Task1-2;§5 组件映射→Task7-15;§6 接缝→Task5;§7 资源→Task2;§8 主题→Task6;§9 窗口装饰→Task16;§10 砍 EDITMODE→Task6;§11 验收→Task17-18;§14 i18n→Task6B + T7(Task9-15) + SettingsView 语言切换器(Task10)。认证(§2 目标5)→Task14。无遗漏。
- **占位符**：新文件均给出真实代码；port 任务以"源 blob + T1-T6 规则 + worked example"替代逐行粘贴（源已逐字在仓库 `_extract/`，粘贴 4000 行属冗余）。
- **类型一致**：`useData()`、`buildSidebarTree(items,filter)`、`highlightSQL(code)`、`nextTheme(t)`、`runQuery(connId,sql)` 在定义与引用处签名一致。

## 执行须知
- 整个计划在 `git` 仓库内逐 task 提交。
- 每个 port 任务的"完整代码"= 对应 `_extract/blobN.txt` 内容经 T1-T6 转换；务必逐字保留 JSX/样式。
- 像素差优先怀疑：字体未加载、CSS 变量缺失、内联 style 漏搬。
