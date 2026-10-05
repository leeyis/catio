# 数据库工作区推荐 A · 实施检查点

用户已通过推荐 A，并追加新建查询左上 / 节点省略号和右键一致两项修改。原来的五个方向 1→6→5→7→8 保持未完目标；此文件不是全量完成声明。

## 第一批：实际产品改造

- SchemaBrowser 的“新建查询”从小图标升级为搜索上方左上的文字按钮；query capability 不可用时禁用。
- MetadataNodeActions 为 schema、表 / 视图 / 函数、类型分组提供唯一菜单模型与 renderer；“…”、右键、ContextMenu / Shift+F10 共用入口。按类型 / capability / callback 显示真实可用操作，View 不冒出 truncate / transfer，函数不出现表管理。
- 菜单 portal 到 body，限定 viewport；Escape / 方向键、外点、滚动 / resize 清理；目标身份按 namespace / name / owner 绑定。连接 / capability / 显示工作区切换使旧菜单失效，不会调用旧目标的迟到动作。
- 保留复制 / 插入 hover 动作、对象管理、迁移、整库导出、ER 与结构模板。演示 / 无 live 仍能有读操作菜单，不提供迁移或实际管理。
- SQL 操作栏显示真实连接 / engine profile / default namespace；运行、选中运行、分析、格式化和更多菜单都有清晰文字。选区失效不回落成整文档执行；文件入口 / 超时 / 行上限 / namespace / 最大化保留。
- 清空 SQL 需确认，保持数据库回滚语义分离。菜单 / 确认在目标、工作区或文档变化时关闭。
- 此批保持“运行 SQL 执行整个编辑区”的旧执行语义，并显式说明；默认“运行当前语句”和全部语句范围 / 诊断还需下一增量实现，不能用一个按钮标签假装完成。
- 没有改 Rust / JDBC，也没有修改 SSH / SFTP / MCP / 外框。源码变更通过 dev HMR 接入当前开发版，但不声称已完成真实桌面 GUI 全部验收。

## 测试与浏览器边界

- 工具栏新增 5 项测试先 red，相关 69 项 green；节点菜单新增 4 red / 1 pass，之后组件 / SchemaBrowser / DbWorkbench / 工具栏相关集合通过。
- 首次全量检查点：TypeScript / build 通过，151 files / 1,361 tests。随后补 hidden-workbench 失效与编辑器卸载选区清理；`db-ui-final-build.log/.exit` TypeScript/build 通过，`db-ui-final-full.log/.exit` 最终同为 **151 files / 1,361 tests，退出码 0**。未用原型示例代替实际产品测试。
- 实际 React / CodeMirror 组件通过一个仅示例元数据、没有后端连接的临时 harness 在前台请求的嵌入浏览器检查：新建查询在搜索上方；TABLE 菜单的省略号与 contextmenu 返回相同三项；菜单在 viewport 内；真实 CodeMirror Ctrl+A 使“运行选中”启用；1440×900 视觉检查通过，console 未捕获 error / warn。
- harness 不是原型按钮替代产品组件，也不是实际数据库读写验收。DOM 点击后的 React commit 需要等一帧，首个同步串行检查过早查 DOM 的失败不算成功。之前原型本身和本批产品集成的证据分开记录。
- 构建有既有 chunk-size 提示，相关测试存在既有 act 警告，不称零 warning。临时 harness / 日志 / 截图不进入 Git。

## 第二批：查询范围、预览与草稿安全交互

- 已接入有界 CST 当前语句 / 选区 / 整脚本范围、查找替换、编辑器共用菜单、结果与计划的源 SQL 定位。
- 已接入对象临时预览 / 固定、跨组件草稿及忙碌状态保护、完整值侧栏、已加载对象快捷操作、字段懒加载与可调树宽。该列表说明代码进展，不代替全部交互验收。
- SQL 文件、表导入和迁移弹窗已报告工作状态；迁移中禁止关闭，新增延迟回执测试验证 pending / receipt / cleanup 路径。
- 本轮 TypeScript 检查通过；完整前端回归 **157 files / 1390 tests，exit 0**（`a-continue-full.log`）。之后新增的迁移关闭保护测试另行定向验证，不混入此全量计数。仍有 act 等警告。
- 隔离 Web SQLite 实测：四条建表 / 插入脚本分别产生回执；两条 SELECT 光标在第二条时仅返回 second=42；源 SQL 定位实际选中第二条；非执行 EXPLAIN 返回 SCAN CONSTANT ROW。
- 首次 QA 连接误将 `:memory:` 填入 database 字段而 host 为空，元数据树显示 0 tables。已纠正为隔离 `A-verified-memory` 连接，重新执行四条脚本后真实树显示 customers / orders，orders 字段懒加载显示 `DECIMAL(28,9)`；不是用 mock 或缓存冒充修复。
- 同一真实 Web SQLite 验证：干净 orders 预览被 customers 替换；固定 customers 后再开 orders，两者保留；BLOB `0x0001` 显示二进制 2 B；TEXT JSON 格式化仍保留 `900719925474099312345`、`1.2300`，且原始格值不变。此为 Web+SQLite 证据，不等于全 desktop / 所有引擎验收。
- 审查新增 5 条语句边界用例先 red：空白选区、有效选区优先、过程体内部语句、DELIMITER 注释/字符串、SQL Server GO / anonymous block。已修复；有界全篇 CST 屏蔽字面量后拒绝无法可靠推断的过程批次，不会默认执行其内部写语句。
- 结果最大化现在只隐藏编辑器而不卸载，保持撤销历史；源 SQL 定位在恢复布局后再选择与聚焦。真实 CodeMirror 用例先 red 后通过。查询文档变化后仍禁止旧范围定位。
- 只读结构速览已接入编辑器/更多操作菜单：用户明确选择 namespace、表/视图；按需读取字段、索引、外键，不执行 SQL、不加载表行、不改变查询 namespace；迟到元数据隔离、失败重试由测试覆盖。
- 字段菜单跟随工作区隐藏和全局搜索切换失效，并监听匹配连接的元数据失效事件刷新；快捷面板不消费 IME Enter / Escape。源码清空后仍保留编辑器，不因空串卸载而丢失撤销入口。
- 浏览器检查发现值侧栏 Copy 缺翻译 key，已改为已有的中英文复制文案；JSON 格式化除输入/深度预算外增加 2 MiB 输出预算。
- 最新构建与 TypeScript 通过（`a-workbench-final-build.exit=0`）；最终全量 **158 files / 1406 tests，exit 0**（`a-workbench-full-3.log`）。两次中间全量失败记录保留：旧 mock 未体现 live selection 契约；旧方言测试读取尚未就绪的缓存 CST，现用有界 ensureSyntaxTree 检查实际 parser，不降低产品解析门禁。
- 新构建真实 Web SQLite 再验：结构速览显示 orders 的类型与一条 FK；结果最大化后保持同一个 CodeMirror DOM，恢复定位真实选中第二条并聚焦；脏查询关闭警告选择继续编辑后内容仍在。保存查询产生真实 40 字节 query.sql 下载，读回与两条 SELECT 一致；不是仅凭按钮点击认定成功。
- 逻辑提交：`3c603a4` 草稿与在途关闭保护基础；`359eff1` 当前语句 / 预览 / 值查看 / 结构速览的工作台接线。两次 staged 审计均通过，用户原有 capabilities.json SHA-256 未变。临时截图、日志、fixture 不提交。

## 第三批：连续审查与入口补齐

- `c2eacf7`：SQLite / DuckDB 使用明确的“数据库文件路径”，空路径禁用测试和连接；隐藏端口、用户名/密码、database、SSL 与 SSH 隧道等不适用字段。运行参数也剔除旧网络设置，不仅隐藏控件。桌面可选已有文件；Web 明确提示是服务器路径，`:memory:` 的临时性可见。新增 3 项先 red，相关 32 项与 tsc 通过；新构建 Web 已通过此入口创建真实隔离 SQLite 连接。
- `711f03d`：事务开始 / 提交 / 回滚等待回执时也登记 busy，阻止关闭路径绕过等待。延迟事务回执用例先 red 后通过。
- `d5fd35e`：CodeMirror 搜索/替换完整中英文 UI、无障碍播报及语言切换；保持查询条件、编辑区内容和撤销历史。真实浏览器 Ctrl+F 显示中文，替换“草稿”为“查询”，Ctrl+Z 恢复原文。
- `0a3cdbc`：桌面 SQL 文件执行补同步启动锁、连接/卸载代际隔离、迟到监听清理；换文件先作废旧预览；监听尚在准备时取消不发出执行；取消失败显示错误；必须有终态进度回执才显示对应结果，native promise 返回但缺回执明确要求先核验。五条新增测试先 red（同时抓到一个未处理 rejection）后通过。
- SQL 文件测试 mock desktop bridge，**不代表 Web 文件上传、物理 driver 取消、流式文件读取或恢复完成**；Rust 端仍在语句之间检查取消，文件读取/注册阶段的取消语义仍需后续后端工作。
- 本阶段完整 build / tsc 与 **161 files / 1416 tests，exit 0** 已通过（`a-final-build-2` / `a-final-full-4`）。主题视觉检查又发现 Amber 下新 ghost 按钮 class 错误导致黑字，已修正为项目的 `btn-ghost` 并对命令入口和复制按钮补样式回归；这项最终复验另记，不能把前一次通过当作未测新代码证据。

- 主题修复最终验证：`a-theme-final-build.exit=0`，`a-theme-final-full` 为 **161 files / 1417 tests，exit 0**。最新 Web 构建 Amber 实测按钮 class 为 `btn btn-ghost sm`、文字 `rgb(205, 193, 174)`，背景 `#221E18`，无 body 横向溢出；不是修改页面 DOM 伪装修复。保留 act / chunk-size 警告，不称零 warning。
- 本批没有 Rust / Java 变更，因此没有无理由重复驱动构建；旧真实驱动矩阵仍只作为历史证据。开发版、安装版与隔离 Web server 保留运行。

## 第四批：文件型重连与 SQL 文件真实执行链路

- `2036fe3`：原生 SQLite / DuckDB 重连不再访问密码缓存或弹密码框；详情与侧栏用文件路径而非 host:port，文件失败内联显示；按真正的 driver family 判断，不把名为 sqlite 的 JDBC profile 当作无密码引擎。旧 profile 的网络、SSL、secret 等字段在构造调用参数时剔除。5 项回归先 red，相关 78 项及 tsc 通过。
- `sql_file_io.rs` 以 64 KiB 块严格解码 UTF-8（可带 BOM）及带 BOM 的 UTF-16LE/BE，跨字节、代理对、注释/tag 边界保真；非法/截断编码、NUL/UTF-32 不静默替换。沿用 200 MiB 文件上限，新增单语句 8 MiB 上限。
- 完整编码和切分预检后，语句保存在私有自动清理的磁盘暂存文件，再逐条读取执行。文件尾编码错误不会先执行前面的写入；不是全脚本 SQL 语法/依赖验证或全局原子事务。SHA-256 指纹把 UI 执行绑定到预览内容，文件变化必须重新预览。
- 执行前登记按连接 / execution ID 隔离的 RAII guard，复用有界 early-cancel 机制；重复在途 ID 不覆盖令牌。准备期间可中止，执行阶段调用驱动的 query_cancellable 并等真实结果，不能通过丢弃写 future 冒称回滚。
- 支持 query-session 的引擎使用一个独立物理会话，文件中的 TEMP 表和 BEGIN/COMMIT 保持同一会话；结束时清理。没有确认 idle 的事务不报成功；已提交的语句与清理回滚的未提交事务明确分开。
- Web 新增本机文件选择与有界字节上传（8 MiB），不接受 renderer 的服务器路径；临时文件属于这次请求，自动清理。执行 / 取消受现有连接 owner gate 约束，进度仅发给发起请求的登录用户；Web 请求响应被关闭也不直接丢弃在途写 future。
- native 和 Web 都返回真实终态回执，事件丢失时不靠猜测判成功；缺回执/未知传输结果不自动重放。重跑已有任务要用户确认已核验数据库，明确“这是新执行，不是断点恢复”。末条正在运行时进度条不冒充 100%；UI 失败明细最多保留最近 100 条，总失败计数不丢失。
- 文件 RPC 终止后（含取消/未知传输结果）才失效元数据缓存。正常取消用本地化状态和部分提交边界提示，不再额外显示英文 `query cancelled` 错误条。
- 初步真实核心测试 6 项 / HTTP 3 项通过，覆盖末尾坏编码零写入、指纹变化零写入、UTF-16 两种字节序、TEMP/事务会话、真正中断 SQLite 当前语句、保留先前提交、owner/路径隔离。后续增加 DuckDB 物理会话路径进入最终矩阵，不把初步 9 项冒称覆盖它。
- 全量前端中间检查点为 **163 files / 1436 tests，exit 0**；其后补元数据失效时机、取消展示与字节数，最终回归另记。不是复用旧版本测试当作新代码证据。

### 真实前台 Web 验收（隔离 loopback 18878）

- 为保留原 18877 QA 与两套桌面进程，使用新的临时 QA head / 隔离数据目录。随机 QA 登录口令未打印，不读取历史部署凭据，没有访问生产服务器。
- 真正上传 `b-good-utf16.sql`，预览识别 UTF-16LE / 3 条语句，执行回执为成功 3、失败 0；之后在真实 CodeMirror 中查询，读回中文 emoji、`900719925474099312345` 文本、`0001` 与空 BLOB 的 HEX。
- 上传 4 句取消样例：前两句建表及写入 7 已提交；第三句 10 亿项递归 SQL 运行中点击取消，收到取消终态。再查询只有 7，第四句写入 99 未执行。没有称整个文件已回滚。
- 取消后重新点击运行出现“新执行、非断点恢复、先核验数据库”的确认；本次取消确认，没有重复执行脚本。
- 在同一新构建 Web 中明确关闭自建内存 QA 连接，重新从详情连接，无密码输入框并成功连接；新内存库生命周期按提示处理，不称旧内存内容恢复。
- 使用真实页面、文件上传工具、CodeMirror 输入及程序化 DOM 点击；不是纯 mock，也不是完整 desktop 人工键鼠验收。截图/数据/失败日志在 `.worktrees/dbx-parity-logs/`，不提交。

### Windows 构建隔离

- 首次扩展后端矩阵退出 101，原因是 Cargo 为 integration targets 自动构建普通二进制，尝试移除仍运行的 `K:/cargo/debug/catio.exe` 被拒绝；不是测试断言通过。`cargo rustc --test` 也会触发此行为，失败记录保留，不循环重试或终止用户开发版。
- 桌面目标增加默认启用、仅门控 target 的 `desktop` feature；测试 runner 用 `--no-default-features` 跳过普通桌面 bin，核心库行为不变。正常 Tauri dev/build 保持默认桌面功能，手动关闭默认 feature 的桌面构建需显式添加 `--features desktop`。没有通过修改/终止运行中的桌面实例来绕过文件锁。

### 本批最终检查点

- `afb6829` 已提交 Windows target 隔离；默认 `desktop` feature / `catio` required-feature 以及独立 `server` feature 经 cargo metadata 核对。重新执行矩阵 `b-file-final-matrix-2.exit=0`：**550 library tests + 10 个 integration targets / 55 tests 全部通过**，包括新增 DuckDB 文件执行会话路径；实际 env gate 已启用，SQL Server 仍是 2019。本轮没有 TLS 专项、未修改 Java 或重建 JAR。
- 最新 Web 构建再次验证：先展开 main（0 tables），上传 430 B UTF-16LE 文件并完成 3 条语句后，树自动刷新为 1 table / `main.b_receipts`，没有手动刷新或修改 DOM 伪造结果。
- 提示明确要求使用限定对象名，不依赖编辑器标签的命名空间或事务；SQL 文件的完整 namespace 目标选择仍不是本批交付内容。
- 审查发现 Mongo / Redis / Elasticsearch 原生控制台仍显示 SQL 文件入口；3 项先 red，已按协议族隐藏该入口，后端也拒绝把这些驱动当 SQL 文件引擎。
- `b-delivery-build` / `b-delivery-full` 的中间检查点为构建、TypeScript 与 163 files / 1438 tests。补原生入口能力门禁后，**`b-feature-build.exit=0`、`b-feature-full.exit=0`，最终 163 files / 1441 tests 全通过**。act / chunk-size 提示仍存在。
- 功能提交 `67651c9`：有界 SQL 文件执行、Web 上传/owner 进度、驱动取消、终态回执、重复执行核验与元数据失效。staged 审计通过；用户 capabilities.json 的原 SHA-256 保持不变。临时 QA example 源文件已移除；没有提交截图、日志、输入文件或数据目录。

## 后续仍需实施 / 补齐验收

1. 当前语句 / 选区 / 全脚本、上下文菜单、搜索和显式结构速览已实现本批路径；继续补方言/过程批次/大脚本预算与全部桌面键盘门禁，不把有界推断称为完整 SQL 编译器。
2. 临时预览 / 固定、草稿保护和字段树已实现本批路径；继续补所有结构类型层级、任务持久化、各入口及逐主题/desktop 完整验收。
3. 已有结果 / 计划的源 SQL 定位；更多引擎、字段血缘与真实优化依据仍待实施。
4. SQL 文件已有有界读取、严格解码、预检暂存、真实驱动取消及有界 Web 上传；仍需持久化任务 / 断网与进程重启后的回执恢复、大于 8 MiB 的 Web 分块上传、其他编码 / 方言、逐驱动取消验收，以及全范围导出 / 迁移 / 一致性。取消是否能打断正在运行的语句仍取决于驱动；不支持时只能等待当前语句真实返回。
5. Mongo / Redis / ES / DuckDB 原生工作区与完整 AI 工具预览审批维护闭环。文件型连接的新建和手动重连入口已改善，但不是 Parquet/CSV/JSON 文件工作流或所有原生数据库工作区已完成。

原型能点击、菜单已出现、测试数量增加都不能代替这些未完成能力。
