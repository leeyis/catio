# AGENTS.md

本文件适用于仓库根目录下的全部内容。更深层目录如出现新的 `AGENTS.md`，以更深层说明为准。

## 项目概览

Catio 是一个 Tauri 2 桌面应用：前端使用 React 18 + Vite + TypeScript，后端使用 Rust/Tauri 提供 SSH、SFTP、隧道、数据库连接、查询、JDBC sidecar 和 MCP 相关能力。

主要边界：

- `src/`: React 前端、状态管理、服务封装、组件、i18n 和样式 token。
- `src-tauri/src/`: Rust 后端命令、SSH/DB/MCP 模块、驱动实现。
- `src-tauri/tests/`: Rust 集成测试，很多真实数据库测试由环境变量控制。
- `src-tauri/jdbc-plugin/`: Java JDBC sidecar，只有改 Java 源码时才重建并 re-vendor JAR。
- `src-tauri/resources/`: 打包资源，包含 vendored `catio-jdbc-plugin.jar`。
- `tests/` 与 `src/**/*.test.*`: Vitest/Testing Library 前端测试。
- `docs/superpowers/`: 设计规格和实施计划。改大功能前先读相关 plan/spec。
- `deploy/test/`: 本地数据库集成测试的 Docker Compose 和环境变量说明。
- `scripts/`: 辅助脚本，包括 JDBC 插件构建、截图和像素 diff。
- `ref-ui/`: 参考 UI 资源，避免无关改动。

不要手改或提交常规生成物：`node_modules/`、`dist/`、`src-tauri/target/`、`src-tauri/jdbc-plugin/target/`、`.worktrees/`、`.gstack/`、截图 diff 产物、临时日志。`src-tauri/resources/catio-jdbc-plugin.jar` 是例外，只有在 JDBC Java sidecar 源码变更后按流程更新。

## 沟通与工作方式

- 与用户沟通使用中文，保留 API、commit、TDD、Rust、TypeScript、Tauri 等英文术语。
- 先读代码和现有文档，再改动。不要凭猜测改跨模块逻辑。
- 改动保持外科手术式范围，只动完成任务必须修改的文件。
- 优先沿用现有组件、服务封装、状态存储和错误处理模式。
- 遇到 SSH/SFTP/隧道相关需求，优先参考 Reach 项目思路；数据库相关需求优先参考 dbx 项目思路。只有这些参考不足时再外查。
- 不要回滚或覆盖用户未要求你处理的改动。开始重要修改前查看 `git status --short`。

## 常用命令

安装依赖：

```powershell
npm ci
```

前端开发：

```powershell
npm run dev
```

Tauri 开发：

```powershell
npm run tauri dev
```

前端类型检查、构建与测试：

```powershell
npx tsc --noEmit
npm run build
npm run test
npx vitest run src/components/modals/NewConnectionModal.test.tsx
```

Rust 后端：

```powershell
Set-Location src-tauri
cargo check
cargo test --lib
```

不要在 `src-tauri` 里直接运行裸 `cargo test` 作为默认全量回归；本项目是 Tauri library crate，裸命令会同时构建 bin target，可能触发 Windows 依赖链接问题。需要集成测试时按 `deploy/test/README.md` 明确列出 `--test ...` 目标。

本地数据库集成测试：

```powershell
docker compose -f deploy/test/docker-compose.yml up --wait
```

然后按 `deploy/test/README.md` 设置 `CATIO_TEST_PG_URL`、`CATIO_TEST_MYSQL_URL` 等环境变量，再运行指定 Rust test targets。未设置对应环境变量的真实数据库测试应跳过而不是失败。

JDBC sidecar：

```powershell
pwsh scripts/build-jdbc-plugin.ps1
```

只在 `src-tauri/jdbc-plugin/src` 下 Java 源码变化时运行。需要 JDK 17+ 和 Maven。运行后确认 `src-tauri/resources/catio-jdbc-plugin.jar` 非空并纳入同一个逻辑变更。

截图/视觉 diff：

```powershell
node scripts/shoot.mjs http://localhost:1420 actual.png 1440x900
node scripts/diff.mjs baseline.png actual.png diff.png
```

## 前端约定

- TypeScript 为 strict 模式，`noUnusedLocals` 和 `noUnusedParameters` 开启。提交前至少跑相关 `vitest` 和 `npx tsc --noEmit`。
- 新 UI 优先复用 `src/components/atoms.tsx`、`src/components/Icon.tsx`、现有 shell/panel/modal 模式和 `src/styles/tokens.css` 变量。
- 新增用户可见文案必须同步更新 `src/i18n/zh.json` 与 `src/i18n/en.json`。
- 新增页面、面板和状态必须支持现有主题切换，不要硬编码单一主题颜色。使用 CSS variables 和现有 design tokens。
- 与 Tauri 通信的前端 API 放在 `src/services/`，通过 `tauriInvoke` 包装。浏览器/jsdom 非 Tauri 环境下应有明确 fallback 或清晰错误，参考 `src/services/db.ts` 与 `src/services/ssh.ts`。
- 持久化数据前确认是否含 secret。连接 profile 不应保存密码、passphrase、private key 内容或临时 token。
- 组件测试使用 Vitest + Testing Library。涉及 Tauri 路径时，通过 mock `@tauri-apps/api/core` 或设置/清理 `window.__TAURI_INTERNALS__`，并在 `beforeEach` 清理 `localStorage`、mock 状态。

## Rust/Tauri 约定

- 新增 Tauri command 时，同时更新 `src-tauri/src/lib.rs` 的 `invoke_handler`，并在前端 `src/services/` 增加类型化封装。
- 数据库能力优先落在 `src-tauri/src/db/`：命令在 `commands.rs`，连接管理在 `manager.rs`，驱动实现按 `drivers/` 下现有 trait 和错误模式扩展。
- SSH/SFTP/隧道能力优先落在 `src-tauri/src/ssh/`，复用 `SessionManager`、ID 生成、known hosts 和事件通道约定。
- 错误使用项目现有 `DbError` 或 SSH 错误类型，给用户可操作的 message。不要把内部 debug dump 当作 UI 错误文案。
- 序列化字段遵循现有 serde/camelCase 约定，确保 TypeScript 接口与 Rust 返回结构一致。
- 长连接、stream、process、driver sidecar 等逻辑必须处理清理路径，避免 orphan process、未关闭通道或 stale manager entry。

## 测试策略

- 前端纯逻辑或 UI 变更：补或更新最邻近的 `*.test.ts` / `*.test.tsx`，优先跑 targeted test，再跑 `npm run test` 或相关集合。
- 后端纯函数或命令核心逻辑：优先加 `cargo test --lib` 可覆盖的单元测试。
- 数据库驱动变更：至少覆盖 unit/embedded 路径；真实服务测试按 `deploy/test/README.md` 使用 env gate，不能要求默认环境必须有外部数据库。
- JDBC 变更：区分 plugin JAR、用户 driver JAR 和 JVM。H2 是内置自测路径；下载驱动或外部引擎测试必须用 env gate。
- UI 结构变化影响视觉时，必要时用 `scripts/shoot.mjs` + `scripts/diff.mjs` 验证。

## Git 与提交

- 遵循现有 `CLAUDE.md`：一个逻辑变更一个 commit；提交信息使用语义化英文前缀，如 `feat:`、`fix:`、`refactor:`、`perf:`、`docs:`、`chore:`，正文用中文。
- 提交前检查 `git status --short`，只暂存本次任务相关文件。
- 不要把真实密码、私钥、生产连接串、下载的第三方 JDBC driver JAR、`.test-drivers/` 或本地日志提交进仓库。
- 如果工作树已有无关未跟踪或修改文件，保留它们，不要清理或重置，除非用户明确要求。

## 安全与数据处理

- Catio 处理 SSH 和数据库凭据。任何新日志、测试 fixture、错误显示、剪贴板内容或 AI prompt context 都必须避免泄露 secret。
- `CATIO_JDBC_DRIVERS_DIR` 下的用户 driver JAR 属于本地运行时数据，不应纳入版本控制。
- `src-tauri/tests/fixtures/` 中已有测试 key 只用于本仓库测试。不要新增真实 key。
- AI panel、MCP target sync、history/snippet 相关变更要明确哪些内容会被持久化或发送给模型。

## 修改前必读

- 通用规范：`CLAUDE.md`
- 数据库/JDBC：`docs/db-engines-integration-PLAN.md`、`src-tauri/jdbc-plugin/README.md`
- 真实数据库测试：`deploy/test/README.md`
- 具体大功能：先查 `docs/superpowers/plans/` 和 `docs/superpowers/specs/` 下同主题文档
