# Catio Web 部署技术规格(Option B)

> 状态:**草案 / 待评审**　·　负责人:eason　·　分支:`spike/web-server`
> 目标读者:决定是否按此方案推进、以及评审接口/安全/演进路径。

---

## 1. 背景与目标

### 1.1 现状
Catio 现为 **Tauri 桌面客户端**:React 前端通过 `invoke(cmd, args)` 调用 Rust 后端的 92 个 `#[tauri::command]`,流式数据(终端、传输、监控、扫描、VNC)经 Tauri 事件 `emit`/`listen` 推送。所有运行态(连接、会话、密钥)放在 7 个进程级 `State`(`ConnManager`/`SessionManager`/`VncManager`…),单进程单用户。

### 1.2 目标
让 catio 能**服务器部署 + 局域网浏览器访问**,无需安装客户端。

### 1.3 阶段划分(按评审决策更新)
| 阶段 | 范围 | 用户假设 |
|------|------|----------|
| **Phase 1(本 spike)** | **全套功能 over HTTP/WS**:DB(查询/对比/浏览)+ SSH 终端 + SFTP;**登录 + 用户鉴权**;Docker 部署 | 小团队:各自**登录**,但**共享同一工作区**(连接/会话共享) |
| **Future** | 正式**多用户**:按用户**隔离**状态与凭据、RBAC、审计;RDP web 化 | 多人 / 半信任网络 |

> **关键澄清(评审拍板)**:Phase 1 的「登录 + 用户」是**访问控制**——决定*谁能用这台服务器*;但已登录用户**暂共享工作区**(同一份 `ConnManager` 等)。「*按用户隔离*连接/会话/凭据」属 **Future**,本阶段只在 `AppState` 留可替换扩展点(§3.2/§8),不提前搭多租户骨架。

### 1.4 非目标(本阶段明确不做)
- **按用户隔离状态/凭据**(已登录用户共享工作区;隔离 = Future)
- RDP 的 web 化(桌面调 mstsc 在服务器上无意义 → Phase 1 直接禁用)
- 移动端、公网暴露加固、RBAC/审计

---

## 2. 架构总览:双 Head + 共享 Core

```
                       ┌──────────────── Tauri IPC ──────── 桌面 app(保留,不改)
   transport-agnostic  │
   Rust core ──────────┤
   (db/drivers, ssh,   │                  ┌─ /api/invoke  (请求-响应,同构 invoke)
    sftp, conn mgr…)   └─ axum head ──────┼─ /ws          (流式:终端/传输/VNC)
                                          └─ 静态文件 dist/ + 注入 __CATIO_SERVER__
                                                  │
   前端(同一份 dist)                              ▼
   transport: isTauri ? invoke()        浏览器(局域网 http://server:port)
            : __CATIO_SERVER__ ? http/ws
            : mock(dev/test)
```

**核心原则**
1. **Core 不动**:DB 驱动、SSH、SFTP、`ConnManager` 等业务逻辑与传输无关,两个 head 共用。
2. **新增而非替换**:Tauri 桌面端零改动;web 是并存的第二个入口(`catio-server` 二进制,复用 `catio_lib`)。
3. **前端单点抽象**:把各 service 现有的 `tauriInvoke` 收敛成一个 `rpc()`,`listen()` 收敛成一个 `subscribe()`,按环境选传输。
4. **同构协议**:HTTP 的 `{cmd, args}` 与 Tauri `invoke(cmd, args)` 一一对应 → 命令逐个迁移、互不影响,后期多用户也不需要改 UI。

---

## 3. 后端设计

### 3.1 新二进制 `catio-server`
- 与桌面共用 `catio_lib`(已是 `rlib`),`src/bin/server.rs` 仅是入口。
- Env:`CATIO_PORT`(默认 8787)、`CATIO_STATIC`(默认 `./dist`)。
- 不影响桌面二进制(`catio`)。

### 3.2 应用状态与多用户扩展点
```
struct AppState {
    conns: Arc<ConnManager>,   // Phase 1:全局共享一份
    // … 其余 manager 同理
}
```
> **多用户扩展点(唯一需要改的地方)**:把「一份 manager」换成「`session_id → 一组 manager` 的 map」,请求从鉴权态解析 `session_id`。transport 已携带会话标识,UI 与命令体均无需改动。

### 3.3 命令暴露:通用分发 `/api/invoke`
- 入参:`{ cmd: string, args: object }`,`args` 与前端传给 `invoke` 的对象完全一致(camelCase)。
- 服务端按 `cmd` 分发到 core(与 Tauri 命令体同构,本身就是对 driver/manager 的薄封装)。
- 返回:成功 = 命令结果 JSON;失败 = `{ error: string }` + HTTP 4xx/5xx。

**Phase 1 暴露清单(全套,分批迁移):**
- **DB(请求-响应,HTTP)**:`db_connect` · `db_test_connection` · `db_disconnect` · `db_query` · `db_exec_batch` · `db_schema` · `db_table_structure` · `db_table_preview`(及后续按需补全其余 DB 命令)
- **SSH/SFTP(HTTP)**:`ssh_connect` · `ssh_disconnect` · `ssh_test` · `sftp_list` · `sftp_download` · `sftp_upload`(改 HTML5)· `sftp_mkdir/rename/delete/read_file/write_file` 等
- **SSH 终端(WS,见 §3.4)**:`term_open` · `term_write` · `term_resize` · `term_close` + 输出帧推送
- **鉴权(HTTP)**:`auth_login` · `auth_logout` · `auth_me` · `user_create/list/delete`(见 §6)

**未暴露/桌面专属命令**(RDP、本地终端、串口):返回明确错误「该命令在 web 端不可用」,前端据此降级(置灰/提示),不静默 mock。

### 3.4 流式通道(Phase 1,WebSocket)
- 单条 `GET /ws`(WebSocket)。消息信封:`{ type: 'sub'|'unsub'|'event'|'cmd', topic, payload }`。
- 现有 `emit` 的 topic 直接映射:`term://{chanId}`、`transfer-complete-{id}`、`vnc-init://{id}` 等 → WS `event` 消息的 `topic`。
- 终端输入:`cmd` 消息(`term_write`/`term_resize`)走同一 WS;输出帧:`event` 消息。
- 需要:心跳(ping/pong)、断线重连、订阅生命周期与连接关闭时的资源回收。

### 3.5 静态服务
- 命中 `dist/` 内文件 → 原样返回(带 content-type)。
- 其余路由 → 返回 `index.html`,并注入 `<script>window.__CATIO_SERVER__=true</script>`(让前端走 HTTP/WS 而非 mock)。同一份 `dist` 在桌面(`isTauri`)与服务器下都能用。

---

## 4. 前端设计

### 4.1 传输抽象 `src/services/transport.ts`
```
rpc<T>(cmd, args): Promise<T>
    isTauri()            → invoke(cmd, args)
    __CATIO_SERVER__     → POST /api/invoke {cmd, args}
    否则(dev/test)       → 交回调用方走 mock

subscribe(topic, handler): unsubscribe        // Tauri: listen;web: WS 订阅
```

### 4.2 服务层改造
- 把各 service 文件里重复的私有 `tauriInvoke` 替换为统一 `rpc`。
- 现有「`if (!isTauri()) return mock`」改为「`if (!isTauri() && !isServer()) return mock`」——**保证 vitest/dev 的 mock 路径不变**(测试不设 `__CATIO_SERVER__`)。
- `listen(...)` 调用点(终端/传输/监控/VNC,共 24 处)改用 `subscribe`。

### 4.3 三态对测试的影响
| 环境 | `isTauri()` | `__CATIO_SERVER__` | 走向 |
|------|------------|--------------------|------|
| 桌面 Tauri | true | — | invoke |
| 浏览器(服务器部署) | false | true | HTTP/WS |
| vitest / vite dev | false | false | mock(现状不变) |

---

## 5. 功能映射与降级

| 功能 | Web 下状态 | 说明 |
|------|-----------|------|
| 数据库(连接/查询/对比/结构) | ✅ 可用 | Phase 1 |
| SSH 终端 | ✅ 可用(WS) | Phase 2 |
| SFTP 浏览/传输 | ✅ 可用 | 上传需从 Tauri 原生拖放改 **HTML5 上传** |
| VNC | ✅ 可用(WS) | 本就是 canvas 流式渲染 |
| 本地终端 / 串口 | ⚠️ 语义变化 | 打开的是**服务器**的 shell/串口,非用户机器 → UI 明确标注或禁用 |
| RDP(mstsc/xfreerdp) | 🚫 禁用 | 在服务器弹桌面客户端浏览器看不到;Future 可做「服务器转推 RDP 流」 |
| Vault/密钥 | 🔁 重设计 | 见 §6 |

---

## 6. 安全与鉴权设计(Phase 1 含登录/用户)

> 从「本机单用户」变为「网络服务」——**所有 SSH/DB 凭据集中存于服务器 = 高价值攻击目标**,责任最重,不可省略。

### 6.1 鉴权(Phase 1 实现)
- **登录 + 用户账户**:用户表(用户名 + 口令),口令用 **argon2**(或 bcrypt)哈希存储,不存明文。
- **会话**:登录成功发会话 token,放 **HttpOnly + SameSite cookie**;`/api/invoke` 与 `/ws` 均校验,未登录一律 401。
- **首启引导**:首次启动无用户时创建初始管理员(env `CATIO_ADMIN_USER/PASSWORD` 或首登设置)。
- **用户管理**:`user_create/list/delete`(Phase 1 简化为管理员可建用户;RBAC = Future)。
- **注意**:Phase 1 鉴权只做*访问控制*——已登录用户**共享工作区**;按用户隔离 = Future。

### 6.2 存储
- 用户表 + 保存的连接配置 + vault 落 **SQLite 文件**(放数据卷 `/app/data`,复用 catio 自带 sqlite 能力)。
- **凭据 vault 主密钥**:候选——① 启动口令/`CATIO_MASTER_KEY` env 解锁;② 不落盘仅内存(重启需重输);③ 绑定首个管理员口令派生。**(开放问题,见 §11)**

### 6.3 传输与网络
| 项 | Phase 1 | Future |
|----|---------|--------|
| 传输加密 | 明文 HTTP / 由反向代理(nginx·caddy)做 TLS 终止 | **强制 WSS/HTTPS** |
| 网络暴露 | 仅绑定局域网网段,不暴露公网 | 可控暴露 + 审计 |
| 鉴权强度 | 登录 + 会话 cookie | + RBAC、token 轮换、审计日志 |

---

## 7. 部署

- **Dockerfile 多阶段**:① `node` 构建前端 `dist/`;② `rust` 构建 `catio-server`;③ 轻量 runtime 镜像(server + dist)。
- 运行:`docker run -d -p 8787:8787 -v catio-data:/app/data catio-server`(参考 dbx 的 `docker run -p 4224 t8y2/dbx`)。
- 持久化:保存的连接配置/vault 落在挂载卷 `/app/data`。
- 局域网访问:`http://<服务器IP>:8787`。

---

## 8. 多用户演进路径(Future,非本阶段实现,但本阶段不能挡路)

1. `AppState` 的单 manager → `Map<session_id, Managers>`(§3.2 已留点)。
2. 增加用户表 + 登录 + 会话 token;`/api/invoke` 与 `/ws` 从 token 解析 `session_id`。
3. Vault 按用户加密隔离;凭据不再全局共享。
4. transport 携带 token(header/cookie)——UI 无改动。
5. 可选 RBAC、审计日志、连接配额。

**本阶段的约束**:不得引入「全局单例且无法按会话拆分」的新假设(命令体保持纯函数式、状态集中在可替换的 `AppState`)。

---

## 9. 里程碑与验收标准

> Phase 1 范围较大(全套 + 登录),按以下顺序增量交付,每步可独立验收、桌面端始终零回归。

| 里程碑 | 交付 | 验收 |
|--------|------|------|
| **M1 骨架+DB** | `catio-server` + 前端 transport(三态)+ DB over HTTP + Dockerfile | ① 局域网另一台机浏览器能新建 DB 连接、跑 SQL、看结果、执行数据对比同步;② **桌面端功能与测试零回归**;③ `docker run` 一键起、`/healthz` 正常 |
| **M2 鉴权** | 登录/用户 + 会话 cookie + 用户管理,贯穿 HTTP+WS | 未登录访问被 401;登录后可用;首启能建管理员 |
| **M3 终端** | WS 通道 + SSH 终端(`term_*` over WS) | 浏览器开远程终端可交互输入输出、resize、关闭 |
| **M4 SFTP** | SFTP 浏览/下载 + **HTML5 上传** | 浏览器浏览远程目录、上传/下载文件 |
| **M5(可选/收尾)** | VNC over WS | 浏览器连 VNC 桌面 |

---

## 10. 风险与取舍

| 风险 | 等级 | 应对 |
|------|------|------|
| 多用户状态隔离(最大) | 高 | Phase 1 显式接受「单会话共享」;架构留点(§3.2/§8)避免返工 |
| 安全责任(凭据集中) | 高 | §6 分阶段;Phase 1 限可信局域网 + 可选令牌;明确不暴露公网 |
| 流式改 WS 的工作量(24 listen / 32 emit) | 中 | Phase 2 单独里程碑;先用 DB(请求-响应)验证整链路 |
| 桌面专属功能降级(RDP/本地终端/串口) | 中 | §5 明确状态;UI 标注或禁用 |
| 维护双 head 成本 | 低-中 | 命令体保持薄封装,逻辑沉到 core,两 head 只是入口 |

---

## 11. 决策与开放问题

### 已拍板(评审决策)
- ✅ **Phase 1 范围**:DB + SSH 终端 + SFTP 全套(含 WebSocket)。
- ✅ **鉴权**:Phase 1 即做**登录 + 用户**(访问控制);按用户隔离状态/凭据 = Future。
- ✅ **多用户时机**:较晚 / 不确定 → 仅在 `AppState` 留扩展点,不提前搭多租户骨架。

### 仍需确认
1. **凭据 vault 主密钥**(§6.2):用 `CATIO_MASTER_KEY` env / 启动口令 / 仅内存(重启重输)/ 绑定管理员口令派生?**(倾向:env 主密钥,简单且可放进 Docker secret)**
2. **TLS**(§6.3):交反向代理(nginx/caddy)做 TLS,应用只跑 HTTP?**(倾向:反代,应用不内置证书)**
3. **数据存储**:用户/连接配置/vault 落 SQLite 文件 + 数据卷 —— 是否认可这一存储选型?
