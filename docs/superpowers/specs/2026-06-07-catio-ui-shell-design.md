# Catio UI 外壳 v1 — 设计文档（子项目 1）

- 日期：2026-06-07
- 状态：已批准，待写实现计划
- 子项目：1 / 4（UI 外壳）

## 1. 背景与全局目标

Catio 是一个把两个开源项目的功能整合进一套统一桌面客户端的产品：

- **Reach**（github.com/alexandrosnt/Reach）— Tauri v2 + Rust(`russh`) + Svelte 5，MIT。提供 SSH 终端、SFTP、跳板/隧道、多机执行、系统监控、加密保险库。
- **dbx**（github.com/t8y2/dbx）— Tauri 2 + Rust(`sqlx`/`tiberius`/`redis-rs`/`mongodb`) + Vue 3，**AGPL-3.0**。提供 40+ 数据库连接、SQL 编辑器、数据网格、ER 图、Schema 工具。

用户已设计好完整 UI，载体是 `ref-ui/Catio (standalone).html`。该文件经解包后发现**本质是一套功能完整的 React 原型**（react/react-dom dev 版 + Babel 浏览器内编译 + 14 个 React 组件 + 32KB 设计令牌 CSS + 完整 mock 数据与交互）。解包源码已存于 `ref-ui/_extract/` 作为实现参照。

**全局第一优先级：尽可能完整、像素级复刻该设计。**

### 项目拆解（多子项目，各自独立 spec→plan→实现）

| 子项目 | 范围 | 许可考量 |
|---|---|---|
| **1. UI 外壳（本文档）** | 把 React 原型 1:1 移植成真正的 Tauri+React+TS 应用，mock 数据跑通 | 无 |
| 2. SSH/终端后端 | 复用 Reach 的 `russh` Rust 栈，接入终端/SFTP/隧道/监控面板 | MIT，无障碍 |
| 3. 数据库后端 | 数据库连接/SQL/数据网格/Schema 工具 | **AGPL-3.0 取舍在此决定**（复用 dbx 代码 → 全产品 AGPL；或基于 sqlx 等 MIT 库自实现） |
| 4. Catio Agent + 真加密 vault/认证 | AI 跨终端与数据库编排、真实加密保险库 | — |

后端各子项目通过本子项目建立的 `services/` 接缝层接入，**接入时不改动 UI 组件**。

## 2. 本子项目目标与非目标

### 目标
1. 把原型 1:1 移植为 Tauri v2 + React 18 + TypeScript(strict) + Vite 应用。
2. 像素级还原：dawn/amber/grove 三套主题、全部视图/面板/侧栏/弹窗、字体、图标、间距、动画。
3. 全部数据走 mock，但经由 `services/` 数据接缝层暴露（为后端子项目预留接口）。
4. 可作为桌面应用在 **Windows 与 macOS** 启动，窗口装饰按系统正确处理。
5. 所有交互行为（开/关标签、切面板、切主题、过滤、认证流程）与原型一致。
6. **国际化（i18n）：中英双语切换**（详见 §14）。原型只有中文，需补 i18n；默认中文以保持像素一致。

### 非目标（明确不做）
- 任何真实 SSH / 数据库 / AI 后端逻辑。
- 真实加密 vault、密码哈希（认证门禁仅 UI 层，沿用原型的 localStorage 模拟）。
- 自动更新、Linux 平台、Android、MCP/CLI。
- 把内联样式重构为 CSS module / Tailwind（留到功能稳定后）。
- **翻译演示/mock 内容**（AI 对话、连接名、示例 SQL、片段描述等）——这些是占位演示数据，未来由后端返回，不属于界面文案，保持原样。i18n 只覆盖 UI 框架文案（§14）。

## 3. 技术选型与理由

- **前端框架：React 18 + TypeScript。** 用户原型本身就是 React，移植近 1:1，像素漂移风险最低；前端与两个 Rust 后端经 Tauri IPC 解耦，源项目用 Svelte/Vue 不影响选型。React 生态对未来重组件也最友好（ER 图有 React Flow、数据网格有 TanStack、CodeMirror/xterm 框架无关）—— 但**本子项目 v1 不引入这些库**，一律 1:1 移植原型自带实现，详见 §5。
- **构建：Vite + Tauri v2。** Tauri 官方一等支持。
- **样式：保留原型 32KB 设计令牌 CSS + 组件内联样式逐字搬运。** "像素级"最稳路径。
- **移植路线 A（忠实 1:1）。** 见下文"已否决方案"。

## 4. 架构与目录结构

```
catio/
├─ src-tauri/                     Rust + Tauri v2
│  ├─ tauri.conf.json             decorations:false；Win 三键 / mac hiddenInset
│  └─ src/main.rs                 仅窗口与基础命令；本期无业务逻辑
├─ index.html
├─ vite.config.ts
├─ tsconfig.json                  strict: true
├─ src/
│  ├─ main.tsx                    挂载 React 根
│  ├─ App.tsx                     ← blob15：状态/路由/标签/面板/认证编排
│  ├─ styles/
│  │   └─ tokens.css              ← 解包出的 32KB 三主题设计令牌，原样
│  ├─ assets/fonts/               ← 提取的 Inter(多字重) + Geist Mono WOFF2
│  ├─ components/
│  │   ├─ Icon.tsx                ← blob8：自定义 lucide 子集，逐字保真
│  │   ├─ atoms.tsx               ← blob3：Btn/IconBtn/Toggle/Chip/IconBadge/
│  │   │                             StatusDot/ConnGlyph/Segmented/SectionHead
│  │   ├─ shell/                  ← blob16：TitleBar/Sidebar/IconRail/ConnRow
│  │   ├─ views/                  ← blob4/blob12：HomeView/VaultView/SettingsView
│  │   ├─ workbench/              ← blob7：WorkbenchTabs/TerminalPane/
│  │   │                             DbWorkbench/SchemaBrowser/highlightSQL
│  │   ├─ dbviews/                ← blob5/blob6：SqlEditor/SqlConsole/
│  │   │                             StructureView/ERDiagram/DataGrid
│  │   ├─ panels/                 ← blob9：PanelShell/AIPanel/SftpPanel/
│  │   │                             MonitorPanel/TunnelsPanel/SnippetsPanel/
│  │   │                             HistoryPanel/DetailsPanel
│  │   ├─ modals/                 ← blob11：NewConnectionModal
│  │   └─ auth/                   ← blob14：LockScreen/FirstRun 认证门禁
│  ├─ services/                   数据接缝（关键）
│  │   ├─ types.ts                Connection/Group/Tab/Snippet/Recent… 类型
│  │   ├─ mockData.ts             ← blob10 mock 数据
│  │   └─ index.ts               services API（listConnections/runQuery 等）
│  └─ state/
│      ├─ ThemeContext.tsx        主题 + 偏好（密度/面板宽度）
│      ├─ DataContext.tsx         useData() 取代 window.DATA
│      └─ useTweaks.ts            从 blob13 剥离出用户偏好部分（去掉 host 协议）
└─ docs/superpowers/specs/        本文档
```

## 5. 组件移植映射

每个解包 blob → 一个 TS 模块。机械转换规则（语义一行不改）：

- `Object.assign(window, {A, B})` 导出 → 标准 `export`。
- 引用 `window.XXX` 组件 → 顶部 `import`。
- `window.DATA` → `useData()`（来自 `DataContext`），或在纯函数里通过参数传入。
- `window.addEventListener('catio-ask-ai', …)` 自定义事件 → 保留（仍是窗口事件总线），或改为 Context 回调（实现期二选一，以不改行为为准）。
- JSX、hooks、内联样式、className、动画 → 逐字搬运。
- 给 props 补 TypeScript 类型（依据 `services/types.ts`）。

组件清单（来自 `Object.assign(window,…)` 导出）：

- **atoms**：Btn, IconBtn, Toggle, Chip, IconBadge, StatusDot, ConnGlyph, Segmented, SectionHead
- **shell**：TitleBar, Sidebar, IconRail, ConnRow（含 `buildSidebarTree` 隧道嵌套逻辑）
- **views**：HomeView, VaultView, SettingsView
- **workbench**：WorkbenchTabs, TerminalPane, DbWorkbench, SchemaBrowser, highlightSQL
- **dbviews**：SqlEditor, SqlConsole, StructureView, ERDiagram, DataGrid
  （v1 全部 1:1 移植原型自带实现；ERDiagram 与 DataGrid **不**改用 React Flow / TanStack，那是后端子项目处理真实/大数据量时再评估的方案）
- **panels**：PanelShell, AIPanel, SftpPanel, MonitorPanel, TunnelsPanel, SnippetsPanel, HistoryPanel, DetailsPanel
- **modals**：NewConnectionModal
- **auth**：锁屏 / 首次运行 / 每用户 vault 隔离（UI 层，localStorage 模拟）

## 6. 数据接缝层（最重要的前瞻设计）

组件**永不直接引用 mock**，统一调用 `services/index.ts` 暴露的 API：

```ts
// services/index.ts —— 本期内部返回 mock；后端子项目把内部换成 Tauri invoke
export async function listConnections(): Promise<Connection[]> { return mock.connections }
export async function runQuery(connId: string, sql: string): Promise<QueryResult> { return mock.queryResult }
// …终端、SFTP、监控、隧道等占位 API
```

- 同步的 mock 可先以同步形态暴露给 `useData()`，但凡未来要走后端的调用一律定义为 `async`，签名现在就定死，后端接入只改实现体。
- `services/types.ts` 是前后端契约的单一事实来源。

## 7. 资源管线

- 从 `Catio (standalone).html` 提取内嵌 WOFF2（base64+gzip 解出，已知字体：Inter 多字重 + Geist Mono），落地为 `src/assets/fonts/*.woff2`。
- 重写 `tokens.css` 中 `@font-face` 的 `src: url(...)` 指向本地字体文件（替换原型里的 UUID 占位）。
- CSS 令牌整段照搬，不增删变量。

## 8. 主题

- `<html data-theme="dawn|amber|grove">` 切换，逻辑沿用原型（标题栏按钮循环切换、写 localStorage、URL hash 可指定）。
- 三套主题的全部变量已在 `tokens.css`，无需重定义。

## 9. 窗口装饰（Windows + macOS）

- `tauri.conf.json`：`decorations: false`。
- **Windows**：保留原型右上三键，接 `getCurrentWindow().minimize() / toggleMaximize() / close()`。
- **macOS**：`titleBarStyle: "Overlay"`（或 hiddenInset）给系统红绿灯留位；标题栏右侧自绘三键在 mac 隐藏；品牌区左侧留出红绿灯空间。
- 拖拽区使用 `data-tauri-drag-region`（替换原型的 `WebkitAppRegion: drag`）；交互控件标注 no-drag。

## 10. 砍掉与保留

- **砍掉**：`EDITMODE` / Tweaks 设计调参面板及其 `__activate_edit_mode` 等 host 协议（blob13，设计工具脚手架，非产品功能）。
- **保留**：用户可见设置（主题、密度、面板宽度等），从 `useTweaks` 中剥离为普通偏好状态。

## 11. 验收标准

1. **像素对比**：用 browse 对以下屏逐张截图，与原型对应屏视觉上无可辨差异：
   - Home、Workbench(终端)、Workbench(SQL + 数据网格)、Settings、各右侧面板(AI/SFTP/监控/隧道/片段/历史/详情)、新建连接弹窗、锁屏/首次运行。
   - 三套主题各抽查关键屏。
2. **可运行**：`npm run tauri dev` 在 Windows 与 macOS 均能启动为桌面应用。
3. **交互一致**：开/关/切标签、切面板、切主题、侧栏过滤与分组折叠、隧道嵌套展示、认证流程（首次运行→创建用户→锁定→解锁→用户隔离 vault）行为与原型一致。
4. **接缝就位**：UI 不直接引用 mock；所有数据经 `services/`。
5. **类型**：TypeScript strict 通过，无 `any` 滥用于公共契约类型。

## 12. 已否决方案

- **B. 移植 + 重构成 idiomatic React**：每动一处都可能像素漂移，且慢，违背"像素级"首要目标。重构留到功能稳定后。
- **C. 直接把原型 bundle 塞进 Tauri webview**：仍是 Babel 浏览器内编译、无 TS、无法干净接后端，死胡同。

## 13. 风险

- **像素漂移**：内联样式与字体微差。缓解 = 路线 A 逐字搬 + 截图像素对比验收。
- **字体提取**：内嵌 WOFF2 的 unicode-range 与字重需完整还原。缓解 = 提取全部 6+ 字体分片并核对 `@font-face`。
- **mac 窗口装饰**：红绿灯与自绘标题栏的留白对齐。缓解 = mac 上单独截图核对。
- **接缝粒度**：API 划分若与未来后端不符需返工。缓解 = `types.ts` 参照 Reach/dbx 的 Tauri command 签名预先对齐。
- **i18n 覆盖不全**：组件移植时漏外置个别中文串。缓解 = 移植转换规则加 T7（外置 UI 文案）；最终用脚本扫描组件内残留中文字面量。

## 14. 国际化（i18n）

原型仅中文，本期补中英双语切换。

- **库**：`i18next` + `react-i18next`。
- **覆盖范围**：仅 **UI 框架文案**（按钮、菜单、标签、表头、占位符、tooltip、设置项、对话框、空状态、认证流程文案等组件内作者书写的中文）。**不**翻译演示/mock 内容（见 §2 非目标）。
- **默认语言 = `zh`**：zh 资源即原型里的中文原文，默认渲染与原型逐字一致 → 不破坏像素验收。`en` 为另一套（实现时翻译）。
- **资源组织**：`src/i18n/{index.ts, zh.json, en.json}`，按组件区域分命名空间（如 `shell`、`home`、`settings`、`panels`、`auth`、`workbench`、`common`）。
- **状态与持久化**：`LanguageContext` 暴露 `lang` 与 `setLang`；写 `localStorage('catio-lang')`；`<html lang>` 同步。
- **切换入口**：Settings 视图内的语言选择（与主题/密度偏好同处）。
- **组件改造规则（移植转换规则 T7）**：移植组件时，把界面中文字面量替换为 `t('ns.key')`，并在 `zh.json` 写入**原中文**、`en.json` 写入英文译文。带变量的用插值（`t('key', { n })`）。演示/mock 文本不动。
- **验收**：默认 zh 下各屏与原型像素一致；切到 en 后界面文案变英文、布局不崩（允许因英文长度产生的合理换行/省略）；刷新后语言保持。
