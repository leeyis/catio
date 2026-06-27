# 远程文件在线编辑 —— 落地方案

> 来源动机：对标 onetcli "Remote File Editing"、Reach "SFTP inline editing"。
> 两者均 Rust+Tauri+russh，思路一致：在 SFTP 浏览基础上，新增"读内容到内存 → 编辑器 → 写回"闭环。

---

## 0. 目标与成功标准（可验证）

用户在 SFTP 面板双击一个文本文件 → 顶层新开一个编辑器 tab → 带语法高亮加载内容 → 修改 → `Ctrl+S` 写回远程 → 有保存状态与冲突提示。

验收清单（每条都可手动验证）：
1. 双击 `/etc/nginx/nginx.conf` ≤2s 打开并按 conf 高亮
2. 改动后 `Ctrl+S` 写回，远程文件内容确实变更（用 `cat` 或重开验证）
3. 二进制文件（如 `.png`）被拦截，提示走"下载"而非乱码编辑
4. 超过阈值（默认 5MB）的文件拒绝在线编辑，提示下载
5. 打开后远程文件被他人改动，保存时检测到冲突并提示（不静默覆盖）
6. i18n（中/英）+ 三主题（dawn/amber/grove）显示正常
7. tab 有 dirty 圆点；关闭未保存 tab 有二次确认
8. 保存后远程文件权限位 (mode) 与属主不丢失

---

## 1. 架构总览

### 关键结论：编辑器 tab 挂在哪？
catio 有**两套独立 tab 系统**：
- **App.tsx 顶层 `Tab`**（`services/types.ts:417`，`kind: 'terminal' | 'sql'`，带 `connId`/`sessionId`）—— SSH 连接工作区，`WorkbenchTabs.tsx` 渲染 tab 条，`TerminalPane.tsx` 渲染内容。
- **DbWorkbench 内部 `WorkbenchTab`**（`kind: table/object/sql/er`）—— 数据库连接工作区。

远程文件来自 **SSH/SFTP 连接**，所以编辑器 tab 必须加到 **App.tsx 顶层 `Tab` 系统**，新增 `kind: 'remote-file'`，与 terminal 并列。**不要**加到 DbWorkbench。

### 数据流
```
SftpPanel 双击文本文件
  └─> openTab({ kind:'remote-file', connId, sessionId, path, title:文件名 })   // App.tsx 提供
        └─> RemoteFileEditor mount
              └─> invoke('sftp_read_file', {sessionId, path, maxBytes})
                    └─> RemoteFileContent { content, isBinary, size, modified, truncated }
                          └─> <CodeEditor language=byExt(path) value=content onSave=save />
                                └─> Ctrl+S: invoke('sftp_write_file', {sessionId, path, content, baseModified})
                                      ├─ baseModified ≠ 远端 mtime → Err(Conflict) → 弹冲突提示
                                      └─ 成功 → 返回新 mtime → 清 dirty
```

---

## 2. 后端（Rust）改动

文件：`src-tauri/src/ssh/sftp.rs` 新增 2 个 command + 1 个结构体；`lib.rs` 注册。
复用：`sftp_transfer.rs::open_sftp()` 建 `SftpSession`，走简单单流（文件 ≤5MB，无需分段/并行引擎）。

```rust
#[derive(serde::Serialize)]
pub struct RemoteFileContent {
    pub content: String,        // UTF-8 文本；二进制时为空
    pub is_binary: bool,        // 含 NUL 或非法 UTF-8 → true
    pub size: u64,
    pub modified: Option<i64>,  // unix mtime，冲突检测基准
    pub mode: Option<u32>,      // 权限位，写回时还原
    pub truncated: bool,        // 超 maxBytes 截断（仅只读预览）
}

#[tauri::command]
pub async fn sftp_read_file(
    session_id: String, path: String, max_bytes: Option<u64>,
    mgr: State<'_, SessionManager>,
) -> Result<RemoteFileContent, SshError> {
    let limit = max_bytes.unwrap_or(5 * 1024 * 1024);
    let sftp = open_sftp(&mgr, &session_id).await?;
    let attrs = sftp.metadata(&path).await?;          // size/mtime/permissions
    let size = attrs.size.unwrap_or(0);
    // 读 min(size, limit+1) 字节判断是否截断
    let bytes = read_to_memory(&sftp, &path, limit).await?;
    let truncated = size > limit;
    let is_binary = bytes.iter().take(8192).any(|&b| b == 0)
        || std::str::from_utf8(&bytes).is_err();
    Ok(RemoteFileContent {
        content: if is_binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },
        is_binary, size,
        modified: attrs.mtime.map(|m| m as i64),
        mode: attrs.permissions,
        truncated,
    })
}

#[tauri::command]
pub async fn sftp_write_file(
    session_id: String, path: String, content: String,
    base_modified: Option<i64>, mode: Option<u32>,
    mgr: State<'_, SessionManager>,
) -> Result<i64, SshError> {
    let sftp = open_sftp(&mgr, &session_id).await?;
    // 1. 冲突检测：保存前再 stat，比对 mtime
    if let Some(base) = base_modified {
        if let Ok(attrs) = sftp.metadata(&path).await {
            if attrs.mtime.map(|m| m as i64) != Some(base) {
                return Err(SshError::Conflict);   // 前端弹"文件已被改动"
            }
        }
    }
    // 2. 原子写：写临时文件后 rename 覆盖，避免半写
    let tmp = format!("{path}.catio.tmp");
    write_all(&sftp, &tmp, content.as_bytes()).await?;
    if let Some(m) = mode { let _ = sftp.set_metadata(&tmp, mode_attrs(m)).await; } // 还原权限
    sftp.rename(&tmp, &path).await?;
    // 3. 返回新 mtime 作为下次保存的 base
    let attrs = sftp.metadata(&path).await?;
    Ok(attrs.mtime.map(|m| m as i64).unwrap_or(0))
}
```

注意点 / 坑：
- **权限/属主**：rename 覆盖会用临时文件的 mode，需 `set_metadata` 还原原始 mode。属主(uid/gid) 普通用户改不了，按现状即可。
- **符号链接**：`metadata` 跟随链接 vs `symlink_metadata`。编辑时应跟随（编辑目标文件）。
- **CRLF**：原样保留，不做换行符转换（避免污染 diff）。
- **降级**：现有 `open_sftp` 已含 exec+base64 回退（ESXi 等），复用即可。
- `SshError` 需新增 `Conflict` 变体 + 序列化给前端识别。

---

## 3. 前端（React）改动

### 3.1 通用 `<CodeEditor>`（新建，不动 SqlEditor）
SqlEditor 与 SQL 强耦合（dialect/JOIN 补全/lint）。**不重构它**（避免 SQL 编辑回归风险），而是新建 `src/components/editor/CodeEditor.tsx`，抽取 CodeMirror 内核：
- 复用：`catioTheme`（消费 `var(--text-primary)` 等主题 token）、`lineNumbers`/`history`/`bracketMatching`/`closeBrackets`/`indentOnInput`、快捷键。
- props：`value, language, readOnly, onChange, onSave`。
- `onSave` 绑定 `Ctrl/Cmd+S`（CodeMirror keymap，`preventDefault`）。

> 后续可把 SqlEditor 重构为 `CodeEditor + SQL 扩展`，但**不在本期**做，降低风险。

### 3.2 按扩展名选语言
`src/components/editor/langByExt.ts`：
```
.json→json  .yml/.yaml→yaml  .js/.jsx/.ts/.tsx→javascript  .py→python
.html→html  .css→css  .md→markdown  .xml→xml  .rs→rust  .sql→sql
.sh/.bash→StreamLanguage(shell)  .toml→toml  .conf/nginx.conf→纯文本或 nginx
Dockerfile→dockerfile  .ini/.properties→properties  其他→纯文本（仍可编辑）
```
需新增依赖（按选定范围）：`@codemirror/lang-{json,yaml,javascript,python,html,css,markdown,xml,rust}` + `@codemirror/legacy-modes`（shell/toml/dockerfile/nginx/properties）。

### 3.3 `RemoteFileEditor.tsx`（新建）
- mount 时 `invoke('sftp_read_file')`；loading/error/binary/truncated 各有占位 UI。
- `isBinary` → 不进编辑器，显示"二进制文件，点此下载"。
- `truncated` → 只读 + 顶部黄条"文件过大，仅预览前 5MB，请下载编辑"。
- 维护 `dirty` / `baseModified`；`Ctrl+S` → `sftp_write_file` → 成功更新 baseModified、清 dirty；`Conflict` 错误 → 弹层"远端已改动：覆盖 / 重新加载 / 取消"。
- 顶部状态栏：路径、编码、行列、dirty 圆点、保存按钮。

### 3.4 顶层 tab 接入（App.tsx + types + WorkbenchTabs）
1. `services/types.ts:417` 扩展：`kind: 'terminal' | 'sql' | 'remote-file'`，加可选 `path?: string`。
2. App.tsx 的 tab 渲染 switch 增加 `remote-file` → `<RemoteFileEditor>` 分支；提供 `openRemoteFile(connId, sessionId, path)`（同 id 复用，id = `rfile:${sessionId}:${path}`）。
3. `WorkbenchTabs.tsx:88` 图标分支加 `kind === 'remote-file' ? 'file-pen'`；dirty 圆点条件从 `kind==='terminal'` 改为也含未保存的 remote-file。

### 3.5 SftpPanel 入口（SftpPanel.tsx）
- 双击文件：当前是 `downloadItem`。改为：双击 → 若可编辑（非二进制判断可后端兜底，前端先按扩展名/大小预判）→ `openRemoteFile`，否则 `downloadItem`。
- 右键菜单新增"用编辑器打开" / "下载"两项并存，避免双击行为争议。
- 需要把 App.tsx 的 `openRemoteFile` 透传到 SftpPanel（panel 已有 connId/sessionId 上下文）。

### 3.6 i18n + 主题
- `i18n/zh.json` + `en.json` 新增 `remoteFile.*` 键（标题、保存、冲突、二进制、过大、未保存确认）。
- 主题：全部消费现有 CSS 变量，无需新增 token。

---

## 4. 关键设计决策（权衡）

| 决策 | 选项 A（推荐） | 选项 B | 取舍 |
|------|--------------|--------|------|
| 传输实现 | 新增内存读写命令 | 复用临时文件下载/上传 | A 干净无残留，需大小上限；B 几乎零后端改动但要管临时文件生命周期。**推荐 A** |
| 编辑器组件 | 新建独立 CodeEditor | 重构 SqlEditor 提取 | A 隔离风险、不碰 SQL；B 复用更彻底但回归面大。**推荐 A（本期）** |
| 保存语义 | 原子写(临时+rename)+还原 mode | 直接覆盖 | A 防半写/保权限；B 简单但有半写风险。**推荐 A** |
| 冲突检测 | mtime 比对 | 不做 | A 防误覆盖他人改动；几乎零成本。**推荐 A** |
| 双击行为 | 文本→编辑，二进制/超大→下载 | 双击始终下载，右键才编辑 | A 体验顺；B 不改变现有肌肉记忆。**需你拍板** |
| 语言高亮范围 | 全量(~12 语言，加依赖) | 最小(纯文本+JSON/YAML) | A 体验好、包体增数百 KB；B 轻。**需你拍板** |

---

## 5. 边界与坑清单
- 二进制识别：前 8KB 含 NUL 或非法 UTF-8 → 二进制。
- 大文件：默认上限 5MB，可设置项；超限只读预览或拒绝。
- 编码：仅 UTF-8（含 lossy）。GBK 等非 UTF-8 文件本期不支持转码（可列后续）。
- 换行：原样保留，不转换 CRLF/LF。
- 符号链接：编辑跟随链接目标。
- 权限：保存还原 mode；属主不可改按系统行为。
- 并发：同一文件重复双击复用同一 tab（id 去重）。
- 大文件内存：后端读入 `Vec<u8>`，上限保护避免 OOM。

---

## 6. 分阶段实施 + 验证检查点

**M1 后端命令**（0.5–1 天）
- 实现 `sftp_read_file` / `sftp_write_file` + `SshError::Conflict` + 注册。
- 验证：写个临时测试，对一台 SSH 主机读 `/etc/hostname`、写一个临时文件并 `cat` 比对；二进制/超大返回正确标志。

**M2 通用编辑器 + 语言映射**（0.5–1 天）
- `CodeEditor.tsx` + `langByExt.ts` + 依赖安装。
- 验证：本地 mock 一个 CodeEditor 故事页，切 json/yaml/py 高亮正常，Ctrl+S 回调触发，三主题正常。

**M3 RemoteFileEditor + tab 接入**（1 天）
- 组件 + App.tsx tab 分支 + types + WorkbenchTabs 图标/dirty。
- 验证：从代码手动 openRemoteFile 打开真实文件，编辑保存，dirty/冲突/二进制/超大四态都走通。

**M4 SftpPanel 入口 + i18n**（0.5 天）
- 双击/右键入口 + 中英文案 + 未保存关闭确认。
- 验证：跑完整验收清单 1–8；`npm test` + `cargo test` 绿。

**总计：约 3–4 人日。**

---

## 7. 不做（本期 out of scope，可列后续）
- 非 UTF-8 编码转码（GBK/Latin-1）
- 大文件流式/分块编辑
- 远程文件 diff / 版本历史
- 多文件 tab 拖拽重排
- 把 SqlEditor 重构合并进 CodeEditor

---

## 8. 已定决策（2026-06-27 确认）
1. **双击行为**：✅ 文本文件双击直接进编辑；二进制 / 超大文件自动回退下载；右键菜单保留"编辑"和"下载"两项。
2. **语言高亮范围**：✅ 全量 ~12 语言（json/yaml/js/ts/py/html/css/md/xml/rust/sql/shell/toml/dockerfile/properties），新增对应 `@codemirror/lang-*` + `@codemirror/legacy-modes` 依赖。
3. **大小上限**：✅ 默认 5MB（超限只读预览，提示下载）。
