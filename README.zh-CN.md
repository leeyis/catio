<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Catio" width="104" height="104" />

# Catio

### 服务器、数据库、隧道、监控与 AI，一个原生工作台搞定。

Catio 是一个基于 **Rust + Tauri 2 + React** 的开源运维与数据库客户端。它把 **SSH 终端**、**SFTP**、**远程监控**、**端口转发**、**VNC/RDP 入口**、**多引擎数据库工作台**、**资产发现**、**Catio Agent** 和 **MCP** 放进一个快速的桌面应用里，同时提供面向团队浏览器访问的 **Server 模式**。

<br/>

[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
![Dual Mode](https://img.shields.io/badge/Desktop_%2B_Server-dual_mode-4c8bf5)
![License](https://img.shields.io/badge/License-MIT-green)

[English](README.md) · **简体中文**

</div>

<div align="center">
  <img src="docs/screenshots/%E4%B8%BB%E9%A1%B5.jpg" alt="Catio 主页工作台" width="920" />
</div>

> 如果你每天都在终端、数据库客户端、隧道脚本、监控页面、AI 对话和表格导出之间切换，Catio 试图把这条工作流做成一个完整产品，而不是六个工具的临时拼接。

---

## 为什么值得点 Star

- **真实基础设施工作流，不是玩具终端**：SSH、SFTP、多标签终端、命令广播、ProxyJump、隧道、SOCKS、远程系统指标、VNC、本地 shell、串口、Telnet、Mosh 和 RDP 启动入口。
- **认真做的数据库工作台**：原生/协议兼容驱动加 JDBC 扩展，结构浏览、可编辑表格、SQL 控制台、EXPLAIN、历史、片段、导入导出、表迁移、SQL 文件执行、Redis/Mongo/Elasticsearch 路径和 ER 元数据。
- **同一套代码同时支持桌面端与 Server 模式**：个人可用 Tauri 桌面客户端，小团队可部署 `catio-server`，通过 Docker/systemd 和浏览器访问，并支持多用户隔离。
- **AI 就在操作现场**：Catio Agent 跟随当前终端或数据库标签，可读取终端缓冲区和 Schema 上下文，支持 Ollama 与 OpenAI 兼容端点。
- **内置 MCP**：把已连接主机和数据库暴露给外部编码代理，带 token、IP 白名单和实时工具调用日志。
- **适合贡献者进入**：TypeScript strict、清晰的 Rust command 边界、Vitest 覆盖、Rust 单元测试和双模式 CI 门禁。

---

## 产品巡览

| 主机工作台 | 数据库工作台 |
|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E7%95%8C%E9%9D%A2-%E5%91%BD%E4%BB%A4%E5%80%99%E9%80%89%2B%E7%B3%BB%E7%BB%9F%E7%9B%91%E6%8E%A7.jpg" alt="SSH 分屏终端、命令候选与系统监控" width="420" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-%E6%95%B0%E6%8D%AE%E9%A2%84%E8%A7%88.jpg" alt="数据库表格预览与编辑" width="420" /> |
| 分屏终端、命令候选、多机执行，以及通过 SSH 采集的 CPU/内存/网络/磁盘/GPU 面板。 | Schema 树、表格预览、筛选、行内编辑、导入导出与 SQL 工具集中在一个数据库标签中。 |

| Catio Agent | 资产发现 |
|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E7%BB%88%E7%AB%AF%E7%95%8C%E9%9D%A2-Agent%E9%97%AE%E7%AD%94.jpg" alt="Catio Agent 解释终端输出" width="420" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E6%89%AB%E6%8F%8F.jpg" alt="网络资产发现扫描进度" width="420" /> |
| 不离开工作台即可询问 shell 输出、终端报错、SQL、表结构和选中上下文。 | 扫描 CIDR/IP 段/主机名，识别服务，尝试凭据/密钥字典，并导入验证通过的资产。 |

| 数据迁移 | Server 与安全设置 |
|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-%E6%95%B0%E6%8D%AE%E8%BF%81%E7%A7%BB.jpg" alt="数据库表迁移对话框" width="420" /> | <img src="docs/screenshots/%E5%A4%9A%E7%94%A8%E6%88%B7%E9%9A%94%E7%A6%BB.jpg" alt="Catio 保险库与用户隔离设置" width="420" /> |
| 在连接之间迁移表数据，支持列映射、追加、清空后写入、Upsert 和进度反馈。 | 本地保险库模式与 Server 模式都避免把连接密码明文写进 profile。 |

<details>
<summary>更多截图</summary>

| Agent 问数 | 深色主题 | 扫描配置 |
|---|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0.jpg" alt="使用 Catio Agent 问数据库" width="280" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0-%E4%B8%BB%E9%A2%982.jpg" alt="深色主题下的 Catio Agent" width="280" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E9%85%8D%E7%BD%AE.jpg" alt="资产发现范围和凭据配置" width="280" /> |

| 扫描结果 | Agent 模型配置 | MCP 设置 |
|---|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E8%87%AA%E5%8A%A8%E5%8C%96%E5%8F%91%E7%8E%B0.jpg" alt="资产发现结果" width="280" /> | <img src="docs/screenshots/Agent%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.jpg" alt="Catio Agent 模型设置" width="280" /> | <img src="docs/screenshots/MCP%E8%AE%BE%E7%BD%AE.jpg" alt="MCP 服务设置" width="280" /> |

| 数据库发现 | 主机发现结果 | 松岚主题 |
|---|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93%E5%8F%91%E7%8E%B0-%E6%89%AB%E6%8F%8F%E9%85%8D%E7%BD%AE.jpg" alt="数据库发现引擎配置" width="280" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E7%BB%93%E6%9E%9C.jpg" alt="主机发现导入结果" width="280" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0-%E4%B8%BB%E9%A2%983.jpg" alt="松岚主题下的 Catio Agent" width="280" /> |

| 主题设置 |
|---|
| <img src="docs/screenshots/%E5%A4%96%E8%A7%82%E8%AE%BE%E7%BD%AE.jpg" alt="Catio 主题设置" width="420" /> |

</details>

---

## 核心能力

### 终端、SSH 与远程运维

- SSH 密码与私钥认证、TOFU known hosts、`~/.ssh/config` 导入、ProxyJump/跳板机支持。
- xterm.js 终端，WebGL 渲染、分屏、搜索、自适应、shell 历史补全，以及跨主机命令广播。
- SFTP 浏览器，支持上传/下载进度、mkdir/rename/delete/touch、远程文本编辑，以及 Server 模式下的浏览器上传/下载端点。
- 本地 shell、串口终端、Telnet、Mosh、内嵌 VNC 客户端和系统 RDP 客户端启动入口。
- 本地/远程/动态 SSH 转发，包括 SOCKS 风格动态隧道。
- 通过 SSH `exec` 实现无 Agent 监控：CPU、内存、网络、磁盘、GPU、Top 进程和 OS 检测。

### 数据库工作台

- CodeMirror 6 SQL 控制台，支持方言感知的高亮、格式化、自动补全、多语句编辑和结果表格。
- Schema 浏览：表、视图、函数、表结构、对象源码、DDL 辅助、ER 关系元数据和 keyspace 视图。
- 可编辑表数据：DML 预览/应用、分页、WHERE/ORDER BY 辅助、列显隐、筛选和危险操作确认。
- 导入 CSV/TSV/JSON/XLSX/XLSM/XLS 到表；导出表格为 XLSX；导出 database/schema SQL；执行大型 SQL 文件并支持进度与取消。
- 在连接之间迁移表数据，支持列映射和 append/truncate/upsert 模式。
- 查询历史与可复用 SQL 片段。
- Redis keyspace 浏览与编辑、Mongo shell 风格路径，以及 Elasticsearch/rqlite 的 HTTP 访问路径。

### Catio Agent 与 MCP

- Agent 提供商：本地 **Ollama** 或 **OpenAI 兼容**端点，支持拉取模型和连接测试。
- Agent 可使用当前终端输出、选中文本、当前数据库 Schema/表上下文和 SQL 片段作为 prompt 上下文。
- 桌面端 MCP server 通过 SSE 暴露已连接主机和数据库，支持 token 鉴权、IP 白名单和实时日志。
- Server 模式提供每用户 MCP endpoint 与 token，外部代理只能访问该用户自己的连接。

### 发现与保险库

- 资产发现支持 CIDR、IP 区间、单 IP 和主机名。
- 可识别 SSH/MySQL/PostgreSQL/Redis/MongoDB，并尝试凭据字典或 SSH 私钥。
- 结果可导入保险库、分组管理，或导出 CSV/JSON，且不会导出命中的明文密钥。
- 本地保险库模式使用账户校验和 AES-GCM 凭据缓存；Server 模式使用 `CATIO_MASTER_KEY` 加密每用户 secret。

---

## 部署模式

Catio 是一个仓库、两个运行入口。

| 模式 | 入口 | 运行时 | 适用场景 |
|---|---|---|---|
| **桌面客户端** | `src-tauri/src/main.rs` / `catio` | Tauri `invoke` + 原生事件总线 | Windows、macOS、Linux 上的个人工作站安装 |
| **Server 模式** | `src-tauri/src/bin/server.rs` / `catio-server` | HTTP `/api/invoke` + WebSocket `/ws` | 局域网/小团队通过 Docker、systemd 或反向代理浏览器访问 |

Server 模式不是一个单独分叉。React UI 和 Rust 核心共用，`src/services/transport.ts` 根据运行环境自动走 Tauri、HTTP 或 WebSocket。

### Server 模式说明

- Server 模式托管 `dist/`，向首页注入 `window.__CATIO_SERVER__=true`，数据保存在 `CATIO_DATA` 下。
- 支持登录/初始化、用户管理、每用户 store、加密的服务端 secret、SSH 终端流、SFTP 传输端点、隧道、监控、原生数据库驱动、管理员资产扫描和每用户 MCP。
- Docker 是最简单的部署方式；二进制部署也支持，但由于共用 crate，服务端仍会间接链接 Tauri/WebKit 依赖。
- JDBC 引擎在桌面端已接通。当前 Docker 镜像默认**不**包含 JRE 或 JDBC plugin 运行路径，Server 模式建议优先使用原生/协议兼容引擎，除非你自定义镜像。
- 本地设备相关能力如本地终端、串口、外部 RDP 客户端启动以桌面端为主，在 Server 模式可能隐藏或受限。

完整部署指南见：[docs/server-mode-deployment.md](docs/server-mode-deployment.md)。

---

## 支持的数据库

Catio 暴露 50+ 个可选数据库 profile。其中一部分走原生 Rust 驱动，一部分走协议兼容，长尾引擎通过 JDBC sidecar 扩展。

| 分类 | 引擎 |
|---|---|
| **核心关系型** | PostgreSQL · MySQL · MariaDB · SQL Server · SQLite · DuckDB |
| **分布式 / NewSQL** | CockroachDB · TiDB · OceanBase (MySQL) · OceanBase (Oracle) |
| **分析型 / OLAP** | ClickHouse · Apache Doris · StarRocks · SelectDB · Databend · Amazon Redshift |
| **国产 / 信创** | openGauss · GaussDB · KingbaseES · Vastbase · HighGo DB · KWDB · GoldenDB · GBase 8a · GreatSQL · PolarDB (MySQL) · TDSQL |
| **文档 / KV / 搜索** | MongoDB · Redis · Elasticsearch · rqlite |
| **JDBC sidecar** | Oracle · IBM Db2 · Snowflake · Apache Hive · Trino · Cassandra · Neo4j · SAP HANA · Teradata · Vertica · Firebird · Exasol · Informix · 达梦 DM · YashanDB · GBase 8s · XuguDB · Apache Kylin · Apache IoTDB · TDengine · InterSystems IRIS · Databricks · Google BigQuery · SUNDB · MS Access · H2 |

JDBC 说明：

- Catio vendored `src-tauri/resources/catio-jdbc-plugin.jar`。
- 桌面端使用 JDBC 时，用户仍需安装 JRE/JDK 17+。
- 项目不再分发专有数据库 driver JAR。用户自行把驱动放入 `CATIO_JDBC_DRIVERS_DIR`。
- H2 已内置，用于自测路径。

---

## 快速开始

### 环境要求

- Node.js 18+ 与 npm
- Rust stable，以及对应操作系统的 [Tauri 2 环境依赖](https://tauri.app/start/prerequisites/)
- 可选：JDK 17+ 与 Maven，仅在重建 JDBC sidecar 时需要

### 运行桌面端

```bash
npm ci
npm run tauri dev
```

### 构建桌面发布版

```bash
npm run tauri build
```

发布产物位于 `src-tauri/target/release/bundle/`。

### 仅前端开发

```bash
npm run dev
```

该模式适合 UI 开发和测试。真实 SSH/数据库能力需要 Tauri 或 Server 模式。

### 使用 Docker 部署 Server 模式

```bash
DOCKER_BUILDKIT=1 docker build -t catio-server:local .

docker run -d \
  --name catio-server \
  --restart unless-stopped \
  -p 8787:8787 \
  -e CATIO_MASTER_KEY="CHANGE_ME_BASE64_32_BYTES" \
  -e CATIO_ADMIN_USER="admin" \
  -e CATIO_ADMIN_PASSWORD="CHANGE_ME_STRONG_PASSWORD" \
  -v catio-data:/app/data \
  catio-server:local
```

浏览器打开 `http://<server-ip>:8787`。面向生产或局域网长期使用时，建议放在 VPN、网关或 HTTPS 反向代理之后，不要把未审计的管理面直接暴露到公网。

---

## 技术栈

| 层 | 技术 |
|---|---|
| **桌面外壳** | Tauri 2、Rust、系统 webview |
| **Server head** | Axum、HTTP `/api/invoke`、WebSocket `/ws`、静态 `dist/` 托管 |
| **后端运行时** | Rust、tokio、russh、russh-sftp、portable-pty、serialport、reqwest |
| **数据库驱动** | tokio-postgres、mysql_async、tiberius、rusqlite、duckdb、mongodb、redis、ClickHouse HTTP、Elasticsearch HTTP、rqlite HTTP、Java JDBC sidecar |
| **前端** | React 18、TypeScript strict、Vite |
| **编辑器 / 终端** | CodeMirror 6、xterm.js with WebGL |
| **AI / 互操作** | Ollama、OpenAI 兼容 chat endpoint、Model Context Protocol |
| **体验基座** | i18next、CSS 变量主题 token、明暗主题变体 |

---

## 项目结构

```text
catio/
├─ src/                         # React 前端：组件、服务、状态、i18n、样式
│  ├─ components/
│  │  ├─ workbench/             # 终端、数据库 pane、VNC、远程文件编辑
│  │  ├─ dbviews/               # SQL 控制台、表格、导入导出/迁移弹窗
│  │  ├─ panels/                # AI、SFTP、隧道、监控、片段、历史
│  │  ├─ scan/                  # 资产发现流程
│  │  └─ views/                 # 主页、保险库、设置
│  ├─ services/                 # Tauri/server/dev 的类型化 transport 封装
│  └─ state/                    # 连接状态、保险库、偏好、会话
├─ src-tauri/
│  ├─ src/
│  │  ├─ ssh/                   # SSH/SFTP/隧道/监控/多机执行
│  │  ├─ db/                    # DB commands、manager、drivers、导入导出/迁移
│  │  ├─ scan/                  # 范围展开、协议探测、并发试登录
│  │  ├─ mcp/                   # 共享 MCP tool core
│  │  ├─ server*.rs             # Server 模式 HTTP/WS/MCP bridge
│  │  ├─ auth.rs                # Server 用户、会话、每用户 store
│  │  └─ secrets.rs             # 加密 secret 存储辅助
│  └─ jdbc-plugin/              # Java sidecar 源码与 README
├─ docs/                        # 计划、规格、部署指南、截图
├─ deploy/test/                 # 本地数据库集成测试 compose stack
└─ scripts/                     # JDBC 构建与视觉检查等辅助脚本
```

---

## 测试

```bash
# 前端类型检查 + Vitest
npx tsc --noEmit
npm run test

# Rust library tests
cd src-tauri
cargo test --lib
```

双模式 CI 还会检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --bin catio
cargo check --manifest-path src-tauri/Cargo.toml --bin catio-server
```

真实数据库集成测试由环境变量控制。先运行 `docker compose -f deploy/test/docker-compose.yml up --wait`，再按 [deploy/test/README.md](deploy/test/README.md) 配置。

---

## 参与贡献

如果你关心开发者工具、数据库客户端、终端、Rust/Tauri，或 AI 辅助运维软件，Catio 有很多适合贡献的入口。

高价值方向：

- 数据库引擎深度：SSL/TLS 参数、方言元数据、JDBC 体验、driver-specific UX
- 终端与远程运维：SFTP 编辑、VNC/RDP 深度、隧道体验、监控探针
- Server 模式：Docker 加固、反向代理文档、审计能力、多用户管理流程
- AI/MCP：更安全的工具策略、更好的上下文选择、更丰富的 MCP tool 覆盖
- QA：定向 Vitest/Rust 测试、视觉检查、真实数据库测试 fixture

本地约定：

- 一个逻辑变更一个 commit。
- 保持外科手术式改动，匹配已有组件、服务和错误处理模式。
- 新增用户可见文案同时写入 `src/i18n/en.json` 和 `src/i18n/zh.json`。
- UI 使用 CSS 变量和现有 design token，保持主题可切换。
- 不要提交真实密码、私钥、生产连接串、下载的专有 JDBC 驱动或本地日志。

如果 Catio 正好覆盖了你想在开源世界里看到的工作流，点一个 star、发 issue、提交 bug 报告、做 benchmark、补截图或提一个小 PR，都会帮助它遇到下一个贡献者。

---

## 许可证

Catio 基于 [MIT License](LICENSE) 开源发布。

---

## 致谢

- [Tauri](https://tauri.app) 提供轻量桌面运行时。
- [`russh`](https://github.com/Eugeny/russh) 与 [Reach](https://github.com/alexandrosnt/Reach) 为 SSH/SFTP/隧道设计提供参考。
- [dbx](https://github.com/t8y2/dbx) 为数据库侧实现模式提供参考。
- [xterm.js](https://xtermjs.org) 与 [CodeMirror](https://codemirror.net) 提供终端和编辑器基础。

<div align="center"><sub>为常年在 shell prompt 与 query console 之间切换的人打造。</sub></div>
