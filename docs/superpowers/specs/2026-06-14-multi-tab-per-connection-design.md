# 一个连接支持多个标签 — 设计文档

- 日期：2026-06-14
- 状态：已确认，待实现
- 范围：工作台标签栏（`WorkbenchTabs`）+ `App.tsx` 标签状态 + `TerminalPane` 通道映射

## 背景与目标

当前一个连接（主机或数据库）在工作台中**只能有一个标签**，因为 tab id 被硬编码为 `tab-${connId}`，且「点击左侧卡片」「连接」等入口都按这个 id 去重。

目标：让一个连接可以拥有**多个标签**。
- 在标签右键菜单「关闭当前」**上方**新增「复制标签」「重命名标签」。
- 复制标签：直接复制一个新标签，标题沿用原名并在尾部加 `(n)` 区分。
- 重命名标签：弹窗让用户修改标签标题。
- 左侧卡片切换：一个连接可能对应多个标签，点击卡片只激活该连接**最近活跃（MRU）**的标签。
- 该能力对**主机连接与数据库连接同样适用**。

## 关键决策（已与用户确认）

1. **终端「复制标签」语义 = 全新独立 shell**：新标签复用同一 SSH `sessionId`，但各自 `termOpen` 拿到独立的 PTY channel，是同一服务器上互不影响的新 shell（对标 iTerm/MobaXterm 的「复制标签」）。
2. **不做跨重启持久化**：标签（含复制副本与自定义标题）仅在当前 App 会话内有效，与现状一致（App 启动时标签栏为空）。
3. **编号规则**：遵循 Windows/Chrome 习惯，副本从 `(1)` 起，原标签保持原名。

## 现有架构关键事实

- `Tab` 结构：`{ id, kind: 'terminal' | 'sql', connId, title, sessionId? }`（`src/services/types.ts`）。
- tab id 现为 `tab-${connId}`，导致一连接一 tab。
- 终端：每个 `TerminalPane` 按 `tab.id` 渲染，各自调用 `termOpen(sessionId)` 得到**独立 channel**；同一 `sessionId` 可开多 channel（Multi-Exec 已用到多 channel）。
- DB：`DbWorkbench` 为纯前端独立状态，复制后共用同一个已激活的后端连接即可，无需新建连接。
- `chanMap`（`App.tsx`）当前按 `sessionId` 存 channel，供 `insertToTerminal` / `canInsert`（把 snippet/AI 文本写入当前终端）使用。
- `reapSession`（`App.tsx`）已是「无剩余 tab 共享该 session/连接时才断开」，多 tab 下天然正确。

## 设计

### 1. 数据模型

- 不再使用 `tab-${connId}`；改用自增唯一 id：`tab-${connId}-${seq}`（`seq` 用 `useRef` 计数器）。
- 不给 `Tab` 加字段。**MRU** 用 `const mruRef = useRef<Record<string, string>>({})`（connId → tabId）跟踪：通过一个 `useEffect([activeTab, tabs])` 在 `activeTab` 变化时写入 `mruRef.current[tab.connId] = activeTab`，避免侵入几十处 `setActiveTab` 调用。

### 2. 右键菜单（`WorkbenchTabs.tsx`）

菜单顺序调整为：

```
复制标签
重命名标签
────────（分隔线）
关闭当前 / 关闭其他 / 关闭所有
```

新增 props：
- `onDuplicate(id: string): void`
- `onRename(id: string, title: string): void`

### 3. 复制标签

新增 App 处理函数 `duplicateTab(sourceId)`：
- 找到源 tab；生成唯一新 id；复制 `kind / connId / sessionId`；标题 = `computeDupTitle(源 tab)`。
- 在源 tab 右侧插入新 tab，并激活。
- 终端：共用 `sessionId` → 新 `TerminalPane` 自行 `termOpen` 得到独立 channel（全新 shell）。
- DB：共用 `connId` → 新建独立 `DbWorkbench` 视图。

`computeDupTitle`：
- 去掉源标题尾部已有的 ` (k)` 得到 `base`。
- 在**同 `connId`** 范围内，取最小未占用的 `n ≥ 1`，标题为 `${base} (${n})`。

### 4. 重命名标签

- `WorkbenchTabs` 内自管理重命名弹窗 UI：`renaming: { id, value } | null`。
- 弹窗：输入框预填当前标题，确定/取消；Enter 确认、Esc 取消。
- 确认时回调 `onRename(id, title)` → App 更新对应 `tab.title`。空标题不提交。
- 重命名后的标题成为后续编号的新 `base`。

### 5. 左侧卡片切换（MRU）

新增 App 辅助函数：

```
function mruTabIdForConn(connId: string): string | undefined {
  const candidates = tabs.filter(t => t.connId === connId)
  if (!candidates.length) return undefined
  const mru = mruRef.current[connId]
  if (mru && candidates.some(t => t.id === mru)) return mru
  return candidates[candidates.length - 1].id
}
```

将以下入口的「按 connId 找/去重 tab」逻辑统一改为「有则激活 MRU，无则新建」：
- `openLiveTab`（SSH 连接结果）
- 卡片点击的 DB 分支（已激活连接 → 打开 SQL 工作台）
- 卡片点击的 host 兜底分支
- `openDetail`（点击卡片打开详情时同步激活其 tab）

仅「复制标签」会产生额外 tab；重复点卡片不再新建。

### 6. 连带修正：`chanMap` 改按 `tab.id` 存

复制后两个终端 tab 共享 `sessionId`，若 `chanMap` 仍按 `sessionId` 存会互相覆盖，导致「插入到终端」打错对象。

- 渲染处 `onChannel` 回调改为按 `tab.id` 写入：`onChannel={(_sid, chan) => setChanMap(m => ({ ...m, [tab.id]: chan }))}`（关闭/卸载时删除 `tab.id` 键）。
- `insertToTerminal`：`const chan = cur ? chanMap[cur.id] : undefined`，`termWrite(cur.sessionId, chan, ...)`。
- `canInsert = !!(cur?.sessionId && chanMap[cur.id])`。

`TerminalPane` 内部逻辑不变（仍以 `sessionId + chanId` 调 IPC）。

### 7. 关闭逻辑

`closeTab / closeOthers / closeAll / reapSession` **无需改动**：
- 关闭一个终端副本 → 该 `TerminalPane` 卸载，关闭它自己的 channel；`reapSession` 检测到仍有其它 tab 共享该 `sessionId`/`connId`，保留底层 SSH 会话 / DB 连接。
- `agentAborts` / `currentConvByTab` 已按 `tab.id` 处理，多 tab 安全。

### 8. i18n 与主题

- 新增文案键并**同步所有语言文件**：
  - `workbench.duplicateTab` = 复制标签
  - `workbench.renameTab` = 重命名标签
  - 重命名弹窗：标题 / 输入占位 / 确定 / 取消（复用已有通用键则不重复新增）。
- 新增 UI（菜单项、分隔线、重命名弹窗）全部使用 CSS 变量，跟随主题。

## 成功标准

- 右键菜单在「关闭当前」上方出现「复制标签」「重命名标签」。
- 点击「复制标签」：出现 `原名 (n)` 副本并激活；终端为同服务器上的新 shell，DB 为新查询工作台。
- 点击「重命名标签」：弹窗可改名，标题即时更新。
- 点击左侧卡片：激活该连接的 MRU 标签，不新建；无标签时才创建第一个。
- 主机连接与数据库连接均适用。
- 关闭当前/其他/所有仍正确；关闭一个副本不影响其它副本与底层会话/连接。
- 「插入到终端」始终作用于当前激活的终端标签。
- 现有测试（含引用「关闭当前」菜单的用例）保持通过；如 `WorkbenchTabs` props 变化则同步更新测试。

## 涉及文件（预估）

- `src/services/types.ts`（如需，`Tab` 注释；本设计不加字段）
- `src/components/workbench/WorkbenchTabs.tsx`（菜单项、复制/重命名回调、重命名弹窗）
- `src/App.tsx`（唯一 id 生成、`duplicateTab`、`renameTab`、`mruTabIdForConn`、各卡片入口改 MRU、`chanMap` 改按 tab.id）
- `src/i18n/*.json`（新增文案）
- 相关测试（`WorkbenchTabs` / `app` / `DbWorkbench` 用例按需更新）

## 非目标（YAGNI）

- 跨重启的标签/会话持久化。
- 复制终端时复刻源 shell 的工作目录或在途状态。
- 拖拽重排标签、标签分屏。
