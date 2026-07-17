<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Catio" width="104" height="104" />

# Catio

### One native workbench for servers, databases, tunnels, monitoring, and AI.

Catio is an open-source operations and database client built with **Rust + Tauri 2 + React**. It brings **SSH terminals**, **SFTP**, **remote monitoring**, **port forwarding**, **VNC/RDP entry points**, **a multi-engine database studio**, **asset discovery**, **Catio Agent**, and **MCP** into one fast desktop app, with an optional browser-accessible **Server mode** for teams.

<br/>

[![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri_2-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
![Dual Mode](https://img.shields.io/badge/Desktop_%2B_Server-dual_mode-4c8bf5)
![License](https://img.shields.io/badge/License-MIT-green)

**English** · [简体中文](README.zh-CN.md)

</div>

<div align="center">
  <img src="docs/screenshots/%E4%B8%BB%E9%A1%B5.jpg" alt="Catio home dashboard" width="920" />
</div>

> If you jump between terminals, SQL clients, tunnel scripts, monitoring tabs, AI chat, and spreadsheet exports every day, Catio is the attempt to make that whole workflow feel like one product instead of six glued-together tools.

---

## Product Tour

| Host workbench | Database workbench |
|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E7%95%8C%E9%9D%A2-%E5%91%BD%E4%BB%A4%E5%80%99%E9%80%89%2B%E7%B3%BB%E7%BB%9F%E7%9B%91%E6%8E%A7.jpg" alt="Split SSH terminals with command suggestions and system monitoring" width="420" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-%E6%95%B0%E6%8D%AE%E9%A2%84%E8%A7%88.jpg" alt="Database table preview and editable grid" width="420" /> |
| Split terminals, command suggestions, multi-exec, and live CPU/memory/network/disk/GPU panels over SSH. | Schema tree, table preview, filtering, inline edits, import/export, and SQL tools in one database tab. |

| Catio Agent | Asset discovery |
|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E7%BB%88%E7%AB%AF%E7%95%8C%E9%9D%A2-Agent%E9%97%AE%E7%AD%94.jpg" alt="Catio Agent explaining terminal output" width="420" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E6%89%AB%E6%8F%8F.jpg" alt="Network asset discovery scanning progress" width="420" /> |
| Ask about shell output, terminal errors, SQL, table schemas, and selected context without leaving the workbench. | Scan CIDR ranges, IP ranges, or hosts; fingerprint services; try credential/key dictionaries; import verified assets. |

| Data transfer | Server and security settings |
|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-%E6%95%B0%E6%8D%AE%E8%BF%81%E7%A7%BB.jpg" alt="Database table transfer dialog" width="420" /> | <img src="docs/screenshots/%E5%A4%9A%E7%94%A8%E6%88%B7%E9%9A%94%E7%A6%BB.jpg" alt="Catio vault and user isolation settings" width="420" /> |
| Move table data between connections with column mapping, append/truncate/upsert modes, and progress feedback. | Local vault mode and Server mode both keep secrets out of plaintext connection profiles. |

<details>
<summary>More screenshots</summary>

| Agent asking data | Dark theme | Scan setup |
|---|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0.jpg" alt="Ask data questions with Catio Agent" width="280" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0-%E4%B8%BB%E9%A2%982.jpg" alt="Catio Agent in dark theme" width="280" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E9%85%8D%E7%BD%AE.jpg" alt="Asset discovery range and credential setup" width="280" /> |

| Scan results | Agent model config | MCP settings |
|---|---|---|
| <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E8%87%AA%E5%8A%A8%E5%8C%96%E5%8F%91%E7%8E%B0.jpg" alt="Asset discovery results" width="280" /> | <img src="docs/screenshots/Agent%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.jpg" alt="Catio Agent model settings" width="280" /> | <img src="docs/screenshots/MCP%E8%AE%BE%E7%BD%AE.jpg" alt="MCP server settings" width="280" /> |

| Database discovery | Host results | Grove theme |
|---|---|---|
| <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93%E5%8F%91%E7%8E%B0-%E6%89%AB%E6%8F%8F%E9%85%8D%E7%BD%AE.jpg" alt="Database discovery engine setup" width="280" /> | <img src="docs/screenshots/%E4%B8%BB%E6%9C%BA%E5%8F%91%E7%8E%B0-%E7%BB%93%E6%9E%9C.jpg" alt="Host discovery import results" width="280" /> | <img src="docs/screenshots/%E6%95%B0%E6%8D%AE%E5%BA%93-Agent%E9%97%AE%E6%95%B0-%E4%B8%BB%E9%A2%983.jpg" alt="Catio Agent in Grove theme" width="280" /> |

| Theme settings |
|---|
| <img src="docs/screenshots/%E5%A4%96%E8%A7%82%E8%AE%BE%E7%BD%AE.jpg" alt="Catio theme settings" width="420" /> |

</details>

---

## Core Capabilities

### Terminal, SSH, And Remote Ops

- SSH password and private-key auth, TOFU known hosts, `~/.ssh/config` import, and ProxyJump/bastion support.
- xterm.js terminal with WebGL rendering, split panes, search, fit, shell history completion, and command broadcast across hosts.
- SFTP browser with upload/download progress, mkdir/rename/delete/touch, remote text editing, and browser upload/download endpoints in Server mode.
- Local shell, serial terminal, Telnet, Mosh, embedded VNC client, and native RDP client launch path.
- Local/remote/dynamic SSH forwarding, including SOCKS-style dynamic tunnels.
- Agentless monitoring over SSH `exec`: CPU, memory, network, disk, GPU, top processes, and OS detection.

### Database Studio

- Query console built on CodeMirror 6 with dialect-aware highlighting, formatting, autocompletion, multi-statement editing, and result grids.
- Schema browser for tables/views/functions, table structure, object source, DDL helpers, ER relation metadata, and keyspace views.
- Editable table data with DML preview/apply, paging, WHERE/ORDER BY helpers, column visibility, filters, and safe destructive-action prompts.
- Import CSV/TSV/JSON/XLSX/XLSM/XLS into tables; export grids to XLSX; export database/schema SQL; run large SQL files with progress and cancellation.
- Transfer table data between connections with mapping and append/truncate/upsert modes.
- Query history and reusable snippets.
- Redis keyspace browsing/editing, Mongo shell-style paths, and Elasticsearch/rqlite HTTP-oriented access.

### Catio Agent And MCP

- Agent providers: local **Ollama** or **OpenAI-compatible** endpoints, with model fetch/test controls.
- The Agent can use current terminal output, selected text, active database schema/table context, and SQL snippets as prompt context.
- Desktop MCP server exposes connected hosts and databases over SSE with token auth, IP allowlist, and live logs.
- Server mode provides per-user MCP endpoints and tokens, so external agents can reach only that user's owned connections.

### Discovery And Vault

- Asset discovery accepts CIDR, IP ranges, single IPs, and hostnames.
- It fingerprints SSH/MySQL/PostgreSQL/Redis/MongoDB and can try credential dictionaries or SSH private keys.
- Results can be imported into the vault, grouped, or exported as CSV/JSON without exporting matched plaintext secrets.
- Local vault mode uses account verification and AES-GCM credential caching; Server mode stores per-user secrets encrypted with `CATIO_MASTER_KEY`.

---

## Deployment Modes

Catio is one repository with two runtime heads.

| Mode | Entry point | Runtime | Best for |
|---|---|---|---|
| **Desktop client** | `src-tauri/src/main.rs` / `catio` | Tauri `invoke` + native event bus | Personal workstation installs on Windows, macOS, and Linux |
| **Server mode** | `src-tauri/src/bin/server.rs` / `catio-server` | HTTP `/api/invoke` + WebSocket `/ws` | LAN/team browser access through Docker, systemd, or a reverse proxy |

Server mode is not a fork. The React UI and Rust core are shared, while `src/services/transport.ts` routes calls to Tauri, HTTP, or WebSocket depending on runtime.

### Server Mode Notes

- Server mode serves `dist/`, injects `window.__CATIO_SERVER__=true`, and stores data under `CATIO_DATA`.
- It supports login/bootstrap, user management, per-user stores, encrypted server-side secrets, SSH terminal streams, SFTP transfer endpoints, tunnels, monitoring, native database drivers, admin-only asset scans, and per-user MCP.
- Docker is the easiest deployment path. Binary deployment is supported, but the server still links Tauri/WebKit dependencies through the shared crate.
- JDBC engines are fully wired for desktop. The current Docker image does **not** bundle a JRE or the JDBC plugin path, so use native/protocol-compatible engines in Server mode unless you customize the image.
- Local-device features such as local terminal, serial, and external RDP client launch are desktop-first and may be hidden or limited in Server mode.

Read the full deployment guide: [docs/server-mode-deployment.md](docs/server-mode-deployment.md).

---

## Supported Databases

Catio exposes 50+ selectable engine profiles. Some use native Rust drivers, some use wire-protocol compatibility, and long-tail engines go through the JDBC sidecar.

| Category | Engines |
|---|---|
| **Core relational** | PostgreSQL · MySQL · MariaDB · SQL Server · SQLite · DuckDB |
| **Distributed / NewSQL** | CockroachDB · TiDB · OceanBase (MySQL) · OceanBase (Oracle) |
| **Analytics / OLAP** | ClickHouse · Apache Doris · StarRocks · SelectDB · Databend · Amazon Redshift |
| **Chinese domestic / 信创** | openGauss · GaussDB · KingbaseES · Vastbase · HighGo DB · KWDB · GoldenDB · GBase 8a · GreatSQL · PolarDB (MySQL) · TDSQL |
| **Document / KV / Search** | MongoDB · Redis · Elasticsearch · rqlite |
| **JDBC sidecar** | Oracle · IBM Db2 · Snowflake · Apache Hive · Trino · Cassandra · Neo4j · SAP HANA · Teradata · Vertica · Firebird · Exasol · Informix · 达梦 DM · YashanDB · GBase 8s · XuguDB · Apache Kylin · Apache IoTDB · TDengine · InterSystems IRIS · Databricks · Google BigQuery · SUNDB · MS Access · H2 |

JDBC notes:

- Catio vendors `src-tauri/resources/catio-jdbc-plugin.jar`.
- End users still need a JRE/JDK 17+ for desktop JDBC usage.
- Proprietary database driver JARs are not redistributed. Put user-supplied drivers in `CATIO_JDBC_DRIVERS_DIR`.
- H2 is bundled for self-test paths.

---

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Rust stable and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS
- Optional: JDK 17+ and Maven, only when rebuilding the JDBC sidecar

### Run The Desktop App

```bash
npm ci
npm run tauri dev
```

### Build A Desktop Release

```bash
npm run tauri build
```

Release bundles are emitted under `src-tauri/target/release/bundle/`.

### Run Frontend-Only Dev

```bash
npm run dev
```

This is useful for UI work and tests. Real SSH/database features require Tauri or Server mode.

### Deploy Server Mode With Docker

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

Open `http://<server-ip>:8787`. For production-like LAN usage, put it behind VPN, a gateway, or an HTTPS reverse proxy; do not expose an unaudited admin surface directly to the public internet.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop shell** | Tauri 2, Rust, system webview |
| **Server head** | Axum, HTTP `/api/invoke`, WebSocket `/ws`, static `dist/` hosting |
| **Backend runtime** | Rust, tokio, russh, russh-sftp, portable-pty, serialport, reqwest |
| **Database drivers** | tokio-postgres, mysql_async, tiberius, rusqlite, duckdb, mongodb, redis, ClickHouse HTTP, Elasticsearch HTTP, rqlite HTTP, Java JDBC sidecar |
| **Frontend** | React 18, TypeScript strict mode, Vite |
| **Editor / terminal** | CodeMirror 6, xterm.js with WebGL |
| **AI / interop** | Ollama, OpenAI-compatible chat endpoints, Model Context Protocol |
| **UX foundation** | i18next, CSS-variable theme tokens, light/dark theme variants |

---

## Project Structure

```text
catio/
├─ src/                         # React frontend: components, services, state, i18n, styles
│  ├─ components/
│  │  ├─ workbench/             # terminals, database panes, VNC, remote file editor
│  │  ├─ dbviews/               # SQL console, grids, import/export/transfer dialogs
│  │  ├─ panels/                # AI, SFTP, tunnels, monitor, snippets, history
│  │  ├─ scan/                  # asset discovery flow
│  │  └─ views/                 # home, vault, settings
│  ├─ services/                 # typed transport wrappers for Tauri/server/dev
│  └─ state/                    # connection stores, vault, preferences, conversations
├─ src-tauri/
│  ├─ src/
│  │  ├─ ssh/                   # SSH/SFTP/tunnels/monitor/multiexec
│  │  ├─ db/                    # DB commands, manager, drivers, import/export/transfer
│  │  ├─ scan/                  # range expansion, probes, concurrent login attempts
│  │  ├─ mcp/                   # shared MCP tool core
│  │  ├─ server*.rs             # Server mode HTTP/WS/MCP bridge
│  │  ├─ auth.rs                # Server users, sessions, per-user stores
│  │  └─ secrets.rs             # encrypted secret storage helpers
│  └─ jdbc-plugin/              # Java sidecar source and README
├─ docs/                        # plans, specs, deployment guide, screenshots
├─ deploy/test/                 # local DB integration-test compose stack
└─ scripts/                     # helper scripts for JDBC build and visual checks
```

---

## Testing

```bash
# Frontend type-check + Vitest suite
npx tsc --noEmit
npm run test

# Rust library tests
cd src-tauri
cargo test --lib
```

Dual-mode CI also checks:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --bin catio
cargo check --manifest-path src-tauri/Cargo.toml --bin catio-server
```

Real-database integration tests are env-gated. Start dependencies with `docker compose -f deploy/test/docker-compose.yml up --wait`, then follow [deploy/test/README.md](deploy/test/README.md).

---

## Contributing

Catio is especially good for contributors who care about developer tools, database clients, terminals, Rust/Tauri, or AI-assisted operations software.

High-impact contribution areas:

- database engine depth: SSL/TLS options, richer dialect metadata, JDBC polish, driver-specific UX
- terminal and remote ops: SFTP editing, VNC/RDP depth, tunnel UX, monitoring probes
- Server mode: Docker hardening, reverse-proxy docs, auditability, multi-user admin workflows
- AI/MCP: safer tool policies, better context selection, richer MCP tool coverage
- QA: targeted Vitest/Rust tests, visual checks, real database test fixtures

Local conventions:

- One logical change per commit.
- Keep changes surgical and match existing component/service/error patterns.
- Add user-visible text to both `src/i18n/en.json` and `src/i18n/zh.json`.
- Keep UI theme-aware by using CSS variables and existing design tokens.
- Never commit real passwords, private keys, production connection strings, downloaded proprietary JDBC drivers, or local logs.

If Catio matches a workflow you want to see in open source, a star, issue, bug report, benchmark, screenshot, or small PR all helps the project reach the next contributor.

---

## License

Catio is released under the [MIT License](LICENSE).

---

## Acknowledgements

- [Tauri](https://tauri.app) for the lightweight desktop runtime.
- [`russh`](https://github.com/Eugeny/russh) and [Reach](https://github.com/alexandrosnt/Reach) as references for SSH/SFTP/tunneling ideas.
- [dbx](https://github.com/t8y2/dbx) as a reference for database-side patterns.
- [xterm.js](https://xtermjs.org) and [CodeMirror](https://codemirror.net) for the terminal and editor foundations.

<div align="center"><sub>Built for people who live between the shell prompt and the query console.</sub></div>
