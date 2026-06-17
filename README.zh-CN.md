<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Catio" width="104" height="104" />

# Catio

### 服务器与数据库，一个工作台全搞定。

一款快速、原生、跨平台的桌面客户端，把 **SSH / SFTP / 终端**、**多引擎数据库工作台**、**无 Agent 监控**、**隧道代理**、**AI 助手** 和 **一键资产发现** 集中到一个精致的窗口里 —— 基于 Rust + Tauri 构建，配以打磨过的 React 界面。

<br/>

[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
![Platforms](https://img.shields.io/badge/Windows_·_macOS_·_Linux-跨平台-4c8bf5)
![License](https://img.shields.io/badge/License-MIT-green)

[English](README.md) · **简体中文**

</div>

> [!NOTE]
> Catio 把运维工程师日常需要的工具集中到一个漂亮的窗口里 —— 你不必再在终端、数据库 GUI、隧道管理器和监控面板之间来回切换。整套界面提供 **简体中文与 English**，并内置多套明/暗主题。

<!-- 在此放置一张产品截图或短 GIF，效果最佳：
<div align="center"><img src="docs/screenshot.png" width="880" /></div>
-->

---

## ✨ 功能亮点

### 🖥️ 终端与 SSH
- **真实 SSH**，基于 [`russh`](https://github.com/Eugeny/russh) —— 支持密码与私钥登录、**ProxyJump / 跳板机** 链路、TOFU known-hosts。
- **GPU 加速终端**（xterm.js + WebGL），自带搜索、自适应、流畅渲染。
- **单连接多标签** 与 **多主机命令广播** —— 一次输入，在整片主机集群上同时执行。
- **Shell 历史** 与内联补全。

### 📂 文件与网络
- **SFTP 浏览器**，在同一条 SSH 会话上浏览与传输文件。
- **隧道与端口转发** 以及 **SOCKS 代理**，轻松抵达内网基础设施。

### 📊 无 Agent 监控
- 通过普通 SSH `exec` 通道实时采集 **CPU / 内存 / 网络 / 磁盘 / GPU** 折线图 —— **远端无需安装任何程序**。

### 🗄️ 多引擎数据库工作台
- 开箱即用支持 **25+ 引擎**（见[完整列表](#-支持的数据库)），通过原生 Rust 驱动、协议兼容，以及可选的**内置 JDBC sidecar** 覆盖其余引擎。
- **SQL 控制台**（基于 CodeMirror）—— 语法高亮、自动补全、多语句编辑。
- **结构浏览**、**查询历史** 与可复用的 **代码片段**。
- 对 **国产 / 信创数据库** 一等支持（openGauss、KingbaseES、GaussDB、TiDB、OceanBase、GBase、Doris、StarRocks、GoldenDB……）。

### 🤖 AI 助手
- 内置 **SQL 与 Shell** 助手，能感知你当前操作的表 / 主机上下文。
- **MCP（Model Context Protocol）** 集成，把你的连接暴露为工具。

### 🔎 自动扫描资产发现
- 给 Catio 一个 **CIDR / IP 段 / 主机名**，它会：
  - **识别** 开放的服务与版本（SSH、MySQL、PostgreSQL、Redis、MongoDB……）；
  - 用 **凭证字典**（以及 **SSH 密钥**）尝试登录，找出真正能登录的目标；
  - 实时输出 **终端风格的扫描日志**，逐次展示每一次尝试；
  - 随后支持把结果 **一键入库** 到保险库、**按分组批量维护**、或将清单 **导出为 CSV/JSON**。

### 🔐 安全优先
- 连接密钥**绝不明文落盘** —— **加密保险库**（PBKDF2 + AES-GCM）在账户验证之下托管它们，会话内密钥仅驻留内存。
- 入库的凭据**首次连接即免重复输入**，且全程不会把明文密码写入磁盘。

### 🎨 精心打磨的体验
- 原生、轻快、体积小 —— Rust release 构建经 LTO 优化并 strip。
- **国际化**（中文 / English）与**多套主题**，基于 CSS 变量设计令牌。

---

## 🧩 支持的数据库

| 分类 | 引擎 |
|---|---|
| **关系型** | PostgreSQL · MySQL · MariaDB · SQL Server · SQLite |
| **分布式 / NewSQL** | CockroachDB · TiDB · OceanBase（MySQL 与 Oracle 模式）· GoldenDB |
| **分析型 / OLAP** | DuckDB · ClickHouse · Apache Doris · StarRocks · SelectDB · Databend · Amazon Redshift |
| **国产 / 信创** | openGauss · GaussDB · KingbaseES · Vastbase · HighGo DB · KWDB · GBase 8a |
| **NoSQL · KV · 检索** | MongoDB · Redis · Elasticsearch |

> 没有原生 Rust 驱动的引擎通过内置 **JDBC sidecar** 连接；Catio 会替你管理驱动 JAR。

---

## 🚀 快速开始

### 环境要求
- **Node.js** 18+ 与 **npm**
- **Rust**（stable）以及对应平台的 [Tauri 2 环境依赖](https://tauri.app/start/prerequisites/)
- *（可选）* **JDK 17+ 与 Maven** —— 仅在你需要重建 JDBC sidecar 时

### 开发运行
```bash
# 安装依赖
npm ci

# 启动桌面应用（Rust 后端 + Vite 前端）
npm run tauri dev
```

### 打包发布版
```bash
npm run tauri build
```
安装包 / 可执行文件生成于 `src-tauri/target/release/bundle/`。

### 仅前端开发（浏览器，无原生后端）
```bash
npm run dev
```

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| **外壳** | [Tauri 2](https://tauri.app)（Rust）—— 极小原生体积，复用系统 webview |
| **后端** | Rust · `tokio` · `russh` / `russh-sftp` · 原生数据库驱动（`tokio-postgres`、`mysql_async`、`tiberius`、`rusqlite`、`duckdb`、`mongodb`、`redis`） |
| **前端** | React 18 · TypeScript（strict）· Vite |
| **编辑器与终端** | CodeMirror 6 · xterm.js（WebGL） |
| **国际化 / 主题** | `i18next` · CSS 变量设计令牌 |
| **互操作** | 长尾引擎走 Java JDBC sidecar · AI 工具走 MCP |

---

## 🗂️ 项目结构

```
catio/
├─ src/                 # React 前端：组件、服务、状态、i18n、样式
│  ├─ components/       #   shell · views · panels · workbench · modals · scan · dbviews
│  ├─ services/         #   对 Tauri command 的类型化封装
│  └─ state/            #   连接 / 分组 / 保险库 状态存储
├─ src-tauri/           # Rust 后端
│  └─ src/
│     ├─ ssh/           #   SSH/SFTP/隧道/监控（SessionManager、known hosts）
│     ├─ db/            #   数据库命令、连接管理、各引擎驱动
│     ├─ scan/          #   自动扫描：范围展开 · 协议探针 · 并发试登录
│     └─ mcp.rs         #   Model Context Protocol 集成
├─ docs/                # 设计规格与实施计划
└─ deploy/test/         # 本地数据库集成测试的 docker-compose
```

---

## 🧪 测试

```bash
# 前端：类型检查 + 单元/组件测试（Vitest + Testing Library）
npx tsc --noEmit
npm run test

# 后端：Rust 单元测试
cd src-tauri && cargo test --lib
```

真实数据库的集成测试均由**环境变量控制**：用
`docker compose -f deploy/test/docker-compose.yml up --wait` 拉起依赖，
再按 `deploy/test/README.md` 配置。未设置环境变量时这些测试会干净跳过。

---

## 🤝 参与贡献

欢迎贡献！以下约定有助于保持代码库健康：

- 一个逻辑变更对应一个 commit；使用语义化前缀（`feat:`、`fix:`、`refactor:`、`perf:`、`docs:`、`chore:`）。
- 改动保持外科手术式范围 —— 沿用现有组件、服务与错误处理模式。
- 任何新增的用户可见文案必须**同时**写入 `src/i18n/zh.json` 与 `src/i18n/en.json`。
- 新 UI 必须支持主题切换（使用设计令牌，不要硬编码颜色）。
- **切勿**提交真实密钥、私钥、生产连接串或下载的 JDBC 驱动 JAR。

完整工作约定见 [`AGENTS.md`](AGENTS.md) 与 [`CLAUDE.md`](CLAUDE.md)。

---

## 📝 许可证

Catio 以 [**MIT License**](LICENSE) 开源发布。

---

## 🙏 致谢

- [Tauri](https://tauri.app) —— 让 Catio 又快又小的轻量桌面运行时。
- [`russh`](https://github.com/Eugeny/russh) 与 [Reach](https://github.com/alexandrosnt/Reach) —— SSH / SFTP / 隧道设计的参考。
- [dbx](https://github.com/t8y2/dbx) —— 数据库侧实现模式的参考。
- [xterm.js](https://xtermjs.org) · [CodeMirror](https://codemirror.net) —— 驱动终端与编辑器的核心组件。

---

<div align="center"><sub>为生活在终端 —— 以及查询控制台 —— 里的人们，用 ❤️ 打造。</sub></div>
