# JDBC 插件打包与驱动管理体验 — 设计文档

- 日期：2026-06-11
- 状态：已确认，待实现
- 背景反馈：连接达梦数据库时「没有地方下载驱动，下载好的驱动也不知道放哪里」，并伴随报错
  `connect failed: JDBC plugin jar not found — build src-tauri/jdbc-plugin (mvn package) or set CATIO_JDBC_PLUGIN_JAR`

## 问题分析

反馈表面是「达梦驱动下载/放置」，排查后发现是两个独立问题：

1. **根因阻断**：JDBC sidecar 插件 jar 没有被打进安装包。
   - `tauri.conf.json` 的 `bundle` 未声明任何 `resources`。
   - `src-tauri/src/db/drivers/jdbc.rs` 的 `plugin_jar_path()` 只检查 `CATIO_JDBC_PLUGIN_JAR` 环境变量和开发构建产物路径
     (`CARGO_MANIFEST_DIR/jdbc-plugin/target/catio-jdbc-plugin.jar`)，二者在用户安装机器上都不存在。
   - 结果：安装版里**所有** JDBC 引擎（达梦、Oracle、DB2…）连接都失败，与具体驱动无关。
   - 该 sidecar 还需要用户机器已装 JVM（`java`），本次按用户决定不内置 JRE。

2. **驱动放置体验**：弹窗对手动驱动引擎只显示「请将驱动 JAR 放入驱动目录」，但
   - 从不展示驱动目录的实际绝对路径（`<app_data>/jdbc/drivers`）；
   - 没有「打开目录」按钮；
   - 没有「选择 JAR 文件」手动导入入口；
   - 导致用户把 jar 放进了安装目录（`D:\Program Files\Catio\`）等错误位置。

3. **达梦驱动其实可一键下载**：`com.dameng:DmJdbcDriver18` 已发布在 Maven Central
   （与用户本地的 `DmJdbcDriver18-8.1.3.62.jar` 同源），只是尚未加入下载注册表。

## 方案概览

分两部分：先修根因（打包 jar），再补体验（下载 + 手动放置可见化）。

### Part 1 — 让 JDBC 在打包应用里可用

**1.1 打包 sidecar 插件 jar**

- 构建管线：`tauri.conf.json` 的 `build.beforeBuildCommand` 在现有 `npm run build` 之后追加
  `mvn -q -DskipTests -f src-tauri/jdbc-plugin/pom.xml package`，使 `tauri build` 自动产出
  `catio-jdbc-plugin.jar`。（README 已要求 JDK 17+/Maven，这一步只是把它接入发布流程。）
- 资源声明：`tauri.conf.json` 的 `bundle` 增加 `resources`，以 map 形式把
  `jdbc-plugin/target/catio-jdbc-plugin.jar` 拍平复制为资源目录下的 `catio-jdbc-plugin.jar`。
- 启动注入：`src-tauri/src/lib.rs` 的 `.setup()` 中，仿照现有「drivers-dir」逻辑新增一段：
  若 `CATIO_JDBC_PLUGIN_JAR` 未设置，用
  `app.path().resolve("catio-jdbc-plugin.jar", BaseDirectory::Resource)` 解析资源 jar，
  存在则 `set_var("CATIO_JDBC_PLUGIN_JAR", ...)`。
- `plugin_jar_path()` 已优先读取该环境变量，逻辑不变（开发态仍走 `CARGO_MANIFEST_DIR` 回退）。

**1.2 JVM 缺失的报错文案**

- 不内置 JRE。改进 `jdbc.rs` 中 spawn 失败的报错，明确提示「未检测到 Java，请安装 JDK/JRE 17+」，
  避免用户面对模糊错误。

### Part 2 — 驱动下载与放置体验

**2.1 达梦/金仓加入一键下载**（均已核实存在于 Maven Central）

- `src-tauri/src/db/drivers/jdbc_config.rs` 的 `download_spec` 增加：
  - `dameng` → `maven("com.dameng", "DmJdbcDriver18", "8.1.3.140", None)`
  - `kingbase` → `maven("cn.com.kingbase", "kingbase8", "9.0.1", None)`
- `src/services/jdbcDrivers.ts` 的 `JDBC_DOWNLOADABLE` 同步加入 `'dameng'`、`'kingbase'`。
- 对应的 `proprietary_engines_have_no_download` 测试用例移除这两个引擎。
- 效果：达梦弹窗直接出现「下载驱动」按钮，一键下载到驱动目录。

**2.2 手动添加 + 目录可见化**（yashandb/gbase8s/xugu/sundb/cassandra 等仍需手动的引擎）

- **展示驱动目录绝对路径**：`JdbcDriverStatus.driversDir` 已有返回值，弹窗当前未渲染；
  以等宽、可选中文本展示，让用户知道把 jar 放哪里。
- **「打开目录」按钮**：新增 Tauri 命令 `jdbc_open_drivers_dir(app)`，用
  `std::process::Command` 调系统文件管理器（Windows `explorer`、macOS `open`、Linux `xdg-open`）
  打开驱动目录；不引入新依赖/新插件。
- **「选择 JAR…」按钮**：前端用已集成的 `@tauri-apps/plugin-dialog` 的 `open()`
  （`filters: [{ name: 'JDBC Driver', extensions: ['jar'] }]`）选取文件，
  再调新命令 `jdbc_import_driver(path, app)`，把所选 jar 复制进驱动目录，返回刷新后的状态。
- **目录内 jar 列表**：`JdbcDriverStatus` 增加字段 `jars: Vec<String>`（驱动目录下所有 `*.jar` 文件名）。
  手动引擎下弹窗展示目录里已有哪些 jar；导入后用户能立刻看到自己的 `DmJdbcDriver18-*.jar`
  出现在列表中，明确「放对了」。

**2.3 国际化与主题**

- 新增文案同步 `src/i18n/zh.json` 与 `src/i18n/en.json`：
  `jdbcDriverDir`（驱动目录）、`jdbcOpenDir`（打开目录）、`jdbcImportJar`（选择 JAR…）、
  `jdbcImporting`（导入中…）、`jdbcDriverJarsPresent`/`jdbcDriverJarsEmpty` 等。
- 按钮沿用现有样式 token，自动适配主题色。

## 受影响文件

- `src-tauri/tauri.conf.json` — beforeBuildCommand + bundle.resources
- `src-tauri/src/lib.rs` — 启动注入 `CATIO_JDBC_PLUGIN_JAR`
- `src-tauri/src/db/drivers/jdbc.rs` — JVM 缺失报错文案（逻辑不变）
- `src-tauri/src/db/drivers/jdbc_config.rs` — `download_spec` 增加 dameng/kingbase + 测试
- `src-tauri/src/db/commands.rs` — `JdbcDriverStatus.jars`；新增 `jdbc_open_drivers_dir`、`jdbc_import_driver`
- `src-tauri/src/lib.rs` — 注册两个新命令
- `src/services/jdbcDrivers.ts` — `JDBC_DOWNLOADABLE` + 新接口封装 + `jars` 字段
- `src/components/modals/NewConnectionModal.tsx` — 目录路径展示、打开目录、选择 JAR、jar 列表
- `src/i18n/zh.json` / `src/i18n/en.json` — 新文案
- `src/components/modals/NewConnectionModal.test.tsx` — 达梦改为下载按钮、手动导入交互

## 测试策略

- **Rust 单测**
  - `download_spec("dameng")`/`("kingbase")` 生成正确的 Maven Central URL 与文件名。
  - `jdbc_import_driver` 把临时 jar 复制进临时驱动目录后，状态 `jars` 正确反映、`installed` 合理。
  - `jdbc_status` 的 `jars` 列表正确枚举目录下 `*.jar`。
  - `jdbc_open_drivers_dir` 仅做薄封装（spawn 文件管理器），不做端到端断言。
- **JS 单测**（`NewConnectionModal.test.tsx`）
  - 选择达梦引擎时显示「下载驱动」按钮（从手动态改为可下载态）。
  - 手动引擎显示驱动目录路径、「打开目录」「选择 JAR…」按钮；点击「选择 JAR…」触发 dialog 并调用 import。

## 不在本次范围

- 不内置 JRE（JVM 仍依赖用户机器已装 Java）。
- 不改动 sidecar 的 JSON 行协议与查询逻辑。
- 不为 yashandb/gbase8s/xugu/sundb 等无 Maven Central 自包含 jar 的引擎添加自动下载。
