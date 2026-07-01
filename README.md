<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Catio" width="104" height="104" />

# Catio

### One workspace for your servers **and** your databases.

A fast, native, cross‑platform desktop client, with an optional browser-accessible Server mode, that unifies **SSH / SFTP / terminals**, a **multi‑engine database studio**, **agentless monitoring**, **tunnels**, an **AI copilot**, and **one‑click network asset discovery** — built on Rust + Tauri, with a polished React UI.

<br/>

[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
![Platforms](https://img.shields.io/badge/Windows_·_macOS_·_Linux-cross--platform-4c8bf5)
![License](https://img.shields.io/badge/License-MIT-green)

**English** · [简体中文](README.zh-CN.md)

</div>

> [!NOTE]
> Catio bundles the day‑to‑day tools of an ops engineer into a single, beautiful window — so you stop juggling a terminal, a DB GUI, a tunnel manager, and a monitoring tab. The full UI ships in **English and 简体中文**, with multiple light/dark themes.

<!-- Drop a product screenshot or short GIF here for maximum impact:
<div align="center"><img src="docs/screenshot.png" width="880" /></div>
-->

---

## ✨ Highlights

### 🖥️ Terminal & SSH
- **Real SSH** powered by [`russh`](https://github.com/Eugeny/russh) — password & private‑key auth, **ProxyJump / bastion** chains, TOFU known‑hosts.
- **GPU‑accelerated terminal** (xterm.js + WebGL) with search, fit, and a smooth render path.
- **Multiple tabs per connection** and **multi‑exec broadcast** — type once, run across a whole fleet of hosts.
- **Shell history** with inline completion.

### 📂 Files & Network
- **SFTP browser** for browsing and transferring files over the same SSH session.
- **Tunnels & port forwarding** plus **SOCKS proxy** support for reaching private infrastructure.

### 📊 Agentless Monitoring
- Live **CPU / memory / network / disk / GPU** sparklines streamed over a plain SSH `exec` channel — **nothing to install on the remote host**.

### 🗄️ Multi‑Engine Database Studio
- **25+ engines** out of the box (see the [full list](#-supported-databases)), via native Rust drivers, wire‑protocol compatibility, and an optional **bundled JDBC sidecar** for everything else.
- **SQL console** with CodeMirror — syntax highlighting, autocompletion, multi‑statement editing.
- **Schema/structure browsing**, **query history**, and reusable **snippets**.
- First‑class support for **Chinese domestic / 信创 databases** (openGauss, KingbaseES, GaussDB, TiDB, OceanBase, GBase, Doris, StarRocks, GoldenDB…).

### 🤖 AI Copilot
- A built‑in assistant for **SQL and shell**, aware of the table/host you're working on.
- **MCP (Model Context Protocol)** integration to expose your connections as tools.

### 🔎 Auto‑Scan Asset Discovery
- Point Catio at a **CIDR / IP range / hostname** and it will:
  - **fingerprint** open services and versions (SSH, MySQL, PostgreSQL, Redis, MongoDB…),
  - try a **credential dictionary** (and **SSH keys**) to find what actually logs in,
  - stream a **live, terminal‑style log** of every attempt,
  - then let you **one‑click import** results into the vault, **batch‑organize** them into groups, or **export** the inventory to CSV/JSON.

### 🔐 Security‑First by Design
- Connection secrets are **never persisted in plaintext** — an **encrypted vault** (PBKDF2 + AES‑GCM) gates them behind account auth, and session‑only secrets stay in memory.
- Imported credentials **connect on first use without re‑prompting**, without ever writing a plaintext password to disk.

### 🎨 Crafted UX
- Native, snappy, and small — Rust release builds are LTO‑optimized and stripped.
- **i18n** (English / 简体中文) and **multiple themes** built on CSS‑variable design tokens.

---

## 🧩 Supported Databases

| Category | Engines |
|---|---|
| **Relational** | PostgreSQL · MySQL · MariaDB · SQL Server · SQLite |
| **Distributed / NewSQL** | CockroachDB · TiDB · OceanBase (MySQL & Oracle modes) · GoldenDB |
| **Analytical / OLAP** | DuckDB · ClickHouse · Apache Doris · StarRocks · SelectDB · Databend · Amazon Redshift |
| **国产 / 信创 (Chinese domestic)** | openGauss · GaussDB · KingbaseES · Vastbase · HighGo DB · KWDB · GBase 8a |
| **NoSQL · KV · Search** | MongoDB · Redis · Elasticsearch |

> Engines without a native Rust driver connect through the bundled **JDBC sidecar**; Catio manages driver JARs for you.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ and **npm**
- **Rust** (stable) + the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS
- *(optional)* **JDK 17+ & Maven** — only needed if you rebuild the JDBC sidecar

### Run in development
```bash
# install dependencies
npm ci

# launch the desktop app (Rust backend + Vite frontend)
npm run tauri dev
```

### Build a release bundle
```bash
npm run tauri build
```
Installers/binaries are emitted under `src-tauri/target/release/bundle/`.

### Deploy Server mode with Docker
```bash
DOCKER_BUILDKIT=1 docker build -t catio-server:local .
docker run -d \
  --name catio-server \
  -p 8787:8787 \
  -v catio-data:/app/data \
  catio-server:local
```
Open `http://<server-ip>:8787`. See [Server mode deployment](docs/server-mode-deployment.md) for required environment variables, binary deployment, reverse proxy guidance, and the desktop/server support matrix.

### Frontend‑only dev (browser, no native backend)
```bash
npm run dev
```

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| **Shell** | [Tauri 2](https://tauri.app) (Rust) — tiny native binary, system webview |
| **Backend** | Rust · `tokio` · `russh` / `russh-sftp` · native DB drivers (`tokio-postgres`, `mysql_async`, `tiberius`, `rusqlite`, `duckdb`, `mongodb`, `redis`) |
| **Frontend** | React 18 · TypeScript (strict) · Vite |
| **Editor & Terminal** | CodeMirror 6 · xterm.js (WebGL) |
| **i18n / Theming** | `i18next` · CSS‑variable design tokens |
| **Interop** | Java JDBC sidecar for long‑tail engines · MCP for AI tooling |

---

## 🚢 Deployment Modes

Catio is maintained as one codebase with two release heads:

| Mode | Entry point | Transport | Best for |
|---|---|---|---|
| Desktop client | `src-tauri/src/main.rs` / `catio` | Tauri `invoke` + native event bus | Personal workstation installs on Windows, macOS, and Linux |
| Server mode | `src-tauri/src/bin/server.rs` / `catio-server` | HTTP `/api/invoke` + WebSocket `/ws` | LAN/team browser access through Docker or a systemd service |

Server mode is intentionally not a separate fork. Shared UI and Rust core stay in sync, while runtime-specific behavior is gated by `window.__CATIO_SERVER__`.

---

## 🗂️ Project Structure

```
catio/
├─ src/                 # React frontend: components, services, state, i18n, styles
│  ├─ components/       #   shell · views · panels · workbench · modals · scan · dbviews
│  ├─ services/         #   typed wrappers around Tauri/server transports
│  └─ state/            #   connection/group/vault stores
├─ src-tauri/           # Rust backend
│  └─ src/
│     ├─ ssh/           #   SSH/SFTP/tunnels/monitor (SessionManager, known hosts)
│     ├─ db/            #   DB commands, connection manager, per‑engine drivers
│     ├─ scan/          #   auto‑scan: range expansion · protocol probes · concurrent login
│     ├─ server*.rs     #   Server mode HTTP/WebSocket/MCP bridge
│     └─ mcp/           #   Model Context Protocol integration
├─ docs/                # design specs & implementation plans
└─ deploy/test/         # docker-compose for local DB integration tests
```

---

## 🧪 Testing

```bash
# Frontend: type-check + unit/component tests (Vitest + Testing Library)
npx tsc --noEmit
npm run test

# Backend: Rust unit tests
cd src-tauri && cargo test --lib
```

Real‑database integration tests are **env‑gated** — spin up dependencies with
`docker compose -f deploy/test/docker-compose.yml up --wait` and follow
`deploy/test/README.md`. Tests skip cleanly when their env vars aren't set.

---

## 🤝 Contributing

Contributions are welcome! A few conventions that keep the codebase healthy:

- One logical change per commit; semantic prefixes (`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `chore:`).
- Keep changes surgical — match existing component, service, and error‑handling patterns.
- Any new user‑facing string must be added to **both** `src/i18n/zh.json` and `src/i18n/en.json`.
- New UI must support theme switching (use design tokens, no hard‑coded colors).
- **Never** commit real secrets, private keys, production connection strings, or downloaded JDBC driver JARs.

---

## 📝 License

Catio is released under the [**MIT License**](LICENSE).

---

## 🙏 Acknowledgements

- [Tauri](https://tauri.app) — the lightweight desktop runtime that makes Catio fast and small.
- [`russh`](https://github.com/Eugeny/russh) and the [Reach](https://github.com/alexandrosnt/Reach) project — references for the SSH / SFTP / tunneling design.
- [dbx](https://github.com/t8y2/dbx) — reference for database‑side patterns.
- [xterm.js](https://xtermjs.org) · [CodeMirror](https://codemirror.net) — the terminal and editor that power the workbench.

---

<div align="center"><sub>Built with ❤️ for people who live in the terminal — and the query console.</sub></div>
