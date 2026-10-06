# 数据库工作区推荐 A · 实施检查点

用户已通过推荐 A，并追加新建查询左上 / 节点省略号和右键一致两项修改。原来的五个方向 1→6→5→7→8 保持未完目标；此文件不是全量完成声明。

最新 UI 要求：数据库界面与功能尽可能对齐 DBX，追求有验证依据的超越；**优先可见的体验变化、统一动作归属和样式，不在不同工具条重复摆放同一个功能**。用户对第一版截图标注的重复入口已经纳入第八批修正。后续设计须遵循 [ACTION-MAP.md](./ACTION-MAP.md)；下面各批记录是历史检查点，不能用旧截图 / 旧计数代表当前版本。

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
- 桌面目标增加默认启用、仅门控 target 的 `desktop` feature；测试 runner 用 `--no-default-features` 跳过普通桌面 bin，核心库行为不变。正常 Tauri dev/build 保持默认桌面功能，手动关闭默认 feature 的桌面构建需显式添加 `--features desktop`。没有手动终止进程来绕过文件锁；但最终进程复核发现旧开发实例在 Cargo 配置热重建时已退出，不能因此声称运行态一直保留。
- 随后修正 `tauri.conf.json` 的 `build.features=["desktop"]`，明确给 Tauri CLI 的 `cargo run --no-default-features` 转发桌面 feature；新增静态契约测试先 red 后 green。恢复启动实际执行了 `--features desktop,desktop`（Cargo 会去重），3m18s 后生成开发窗口。新开发实例 PID 57024、窗口句柄 63507618；安装版 PID 18216 未终止，旧开发控制台保留，新控制台 PID 61808。旧开发实例的临时会话不能称作一直未中断。

### 本批最终检查点

- `afb6829` 已提交 Windows target 隔离；默认 `desktop` feature / `catio` required-feature 以及独立 `server` feature 经 cargo metadata 核对。重新执行矩阵 `b-file-final-matrix-2.exit=0`：**550 library tests + 10 个 integration targets / 55 tests 全部通过**，包括新增 DuckDB 文件执行会话路径；实际 env gate 已启用，SQL Server 仍是 2019。本轮没有 TLS 专项、未修改 Java 或重建 JAR。
- 最新 Web 构建再次验证：先展开 main（0 tables），上传 430 B UTF-16LE 文件并完成 3 条语句后，树自动刷新为 1 table / `main.b_receipts`，没有手动刷新或修改 DOM 伪造结果。
- 提示明确要求使用限定对象名，不依赖编辑器标签的命名空间或事务；SQL 文件的完整 namespace 目标选择仍不是本批交付内容。
- 审查发现 Mongo / Redis / Elasticsearch 原生控制台仍显示 SQL 文件入口；3 项先 red，已按协议族隐藏该入口，后端也拒绝把这些驱动当 SQL 文件引擎。
- `b-delivery-build` / `b-delivery-full` 的中间检查点为构建、TypeScript 与 163 files / 1438 tests。补原生入口能力门禁后，**`b-feature-build.exit=0`、`b-feature-full.exit=0`，最终 163 files / 1441 tests 全通过**。act / chunk-size 提示仍存在。
- 功能提交 `67651c9`：有界 SQL 文件执行、Web 上传/owner 进度、驱动取消、终态回执、重复执行核验与元数据失效。staged 审计通过；用户 capabilities.json 的原 SHA-256 保持不变。临时 QA example 源文件已移除；没有提交截图、日志、输入文件或数据目录。

### 开发运行态恢复后的补全门禁回归

- 重新检查发现旧开发版已退出后，没有掩盖为“保留运行”。`f3da278` 补上 Tauri 的显式 desktop feature 接线及启动契约测试，实际恢复开发版窗口；安装版保留。随后在 PID 57024 持续运行时，`b-desktop-alive-regression` 的 550 library + SQLite/DuckDB/HTTP 10 项集成检查通过，证明新的测试命令不再要求关闭开发版。
- 恢复后的前端全量 `b-recovery-full` 有 1 个真实失败：CTE 字段候选混进了全局关键字。根因是 CodeMirror 发布的 `LanguageState.tree` 落后于 `ensureSyntaxTree` 所在的 ParseContext；lang-sql 内置关键词源和旧 ifNotIn 读取了前者。
- 确定性回归保留 SQL 根节点的 language data、模拟其已发布子树落后，并保持新 ParseContext 可用；关键词/字面量/预算耗尽场景先 5 red / 1 pass，caller extra-source 再补 2 red。初版只 mock 导出函数未影响库内部引用，不把那次通过当作复现证据。
- 所有 SQL 补全源现在先经过有界就绪树门禁；keyword 源额外排除限定名 / 引号标识符 / 点号。字段/CTE 与函数/JOIN源保持原有职责，普通关键字仍复用 lang-sql 列表；预算耗尽不回落成全局候选。生产解析预算仍是 10 ms，没有为通过测试调高预算。
- 作用域语义测试先预热测试 fixture 的解析上下文，时序/预算由专门的受控测试验证；受控测试还断言真实的 2/3 个补全源仍注册，避免通过移除语言数据制造空结果。
- `b-complete-build` / `b-complete-full` 的构建、TypeScript 与 165 files / 1450 tests 全通过；加强 fixture 就绪和 2/3 个源仍注册的断言后，**`b-final-verification-full.exit=0`，最终仍为 165 files / 1450 tests，tsc 无错误**。`add8ea8` 已提交补全门禁修复。保留既有 act / chunk-size 警告，不将 desktop 窗口存在当成全部桌面交互已验收。
- 最终现场确认开发版 PID 57024 与安装版 PID 18216 均仍存在并有窗口。用户 capabilities.json 哈希未变，所有提交审计通过。

## 第五批：诊断、方言与元数据身份一致

- `5405213` 统一补全 / JOIN / 诊断的标识符匹配，修复 PostgreSQL 未引用名称被同形大小写对象抢占；Oracle 双引号改为标识符并保留 q-literal，SQL Server `#` / `##` 临时对象不再让当前语句边界误判。相关新增场景先 5 red；此处是编辑器方言测试，不是新一轮 Oracle / SQL Server 实例验收。
- `619c193` 用编辑器实际方言的增量 CST 替换诊断中的独立旧扫描器；字符串、引用名、美元 / q 引用、转义与块注释不再用通用正则猜测。错误范围保留 UTF-16 偏移及行列，提示以 code 国际化，输入抑制不再依赖中文 message。
- 表引用保留 namespace 与 loaded / unloaded / error / truncated 状态；完整空目录可以检查，未加载 / 出错 / 不完整目录不推断缺失，也不退回 demo。警告说明“目录未收录不证明不存在”，不把临时或会话对象误称为数据库错误。
- CTE 按语句 / 查询块隔离，覆盖显式列、引用名、递归与各方言前向可见性；SQL Server / Oracle 隐式递归、SQLite 可省略 RECURSIVE、Oracle / MySQL / H2 DUAL 分别处理。表函数与 EXTRACT / SUBSTRING 中的 FROM 不冒充表来源。DDL / 会话变更脚本的对象检查保守跳过，仍不是完整 SQL 校验器。
- 文档 200k 字符、解析 20 ms、遍历 8k 节点、目录 20k 名称、查询块 12 层及语义提示数量均有界；预算耗尽 / CST 未就绪给出未检查提示，不把无结果伪装成校验成功。连接、namespace、元数据和语言变化重新 lint，真实 EditorView 测试确认文档 / 选区 / undo 未丢失。
- 新诊断场景初始 42 red / 1 pass；方言递归规则再补 5 red 后通过。定向 185 项通过后补充最终规则，`c-diagnostics-final-build.exit=0`、`c-diagnostics-final-full.exit=0`：**169 files / 1509 tests，TypeScript / build 通过**。既有 act / chunk-size 提示保留。
- 真实 Web + SQLite（loopback 18878，独立 C-Diagnostics-QA 内存库）：带引用名和显式列的 CTE 执行返回 `)`；两条语句中仅第二条越界引用 r 被标记。切英文与 Grove 后同一 SQL 的提示更新，文本未改变；DOM / computed-style 检查无横溢出，提示位于 viewport 内。截图与证据 `c-diagnostics-browser.json` 是浏览器检查点，后续递归 / DUAL 规则另有单元回归，不冒称商业引擎实测或像素 diff。

## 第六批：相关子查询与横向关联补全

- `6bbad50` 按查询块传递真正可见的外层绑定；最近同名别名遮蔽外层，普通派生表屏蔽同层来源，LATERAL / APPLY 仅能看到之前的来源，不能借用自己 / 后续 JOIN / 其他 UNION 分支或先前语句。DuckDB 隐式 lateral 单独处理，不把它套到 PostgreSQL。
- FROM 表函数不再套用同名物理表的列；显式列名及部分列重命名按位置保留，SQL Server table hints 不冒充函数 / 列名。函数参数（含内部子查询）只继承允许的输入来源。未解析出的厂商返回类型不猜测。
- 外层可见字段支持限定星号投影；无 FROM 的 `*` 不会扩展成外层所有列。前向 / 递归 CTE 先占据名称，未知列保持未知，不降级到同名物理表；完整前向投影推导仍未交付。
- namespace 限定补全直接导航已加载元数据，避免重走全语句 alias 扫描而绕过边界；接受候选统一使用安全标识符引用。旧原始 namespace fixture 因此由 `app.orders` 变成 `app."orders"`，Tab 接受语义保留，并有实际 popup / Tab 回归。
- 新增 44 项作用域用例：首轮 16 red / 15 pass；审查追加 namespace 同名 alias、点后对象、DuckDB 隐式 lateral、函数参数与前向 CTE 遮蔽用例并逐项修复。`c-scope-final-build.exit=0`、`c-scope-final-full.exit=0`，最终 **170 files / 1554 tests，全绿**；包含现有非数据库前端回归。本批未改 Rust / Java，不复用历史矩阵冒充新后端测试，也不无理由重建 JAR。
- 最终构建 `index-DpVKxuwL.js` 在真实可见 Web 中验收：SQLite 相关 EXISTS 内只给出 `derived_id`，Tab 接受后执行返回 77；DuckDB 未写 LATERAL 的派生表内只给出 `duck_value`，Tab 接受后执行返回 88。两个场景仅用常量 CTE，不修改数据表；记录 `c-scope-browser.json`。SQL Server APPLY / Oracle 仍区分为编辑器测试证据。
- QA 主题 / 语言已恢复 Dawn / 中文，两份 QA SQL 文本保留；安装版 18216、开发版 57024、原 QA 41428 和文件 QA 54968 均现场确认仍在。浏览器的结果文本 / 单元格等待曾超时，后续读取真实结果确认成功，没有盲目重放；侧栏选择有少量明确记录的 DOM 事件辅助，不冒充全部人工键鼠或完整 desktop 验收。

## 第七批：裸列与表达式上下文补全

- `28e9631` 对照 DBX `buildColumnItems`、SELECT alias 与上下文划分，把 SELECT / WHERE / ON / GROUP BY / ORDER BY / HAVING / USING / 函数参数中的裸列候选限定到当前查询块；多来源显示限定标签并插入带来源的 SQL，避免未加载来源造成无歧义假象。相关外层列保持限定，派生表与后续 JOIN 不越界。
- 复用原有 scope / CTE / identifier 基础；语句末尾空白归属未结束语句，但不跨分号借用前一语句。SELECT 输出别名按方言与表达式位置开放；集合查询末尾排序只使用第一分支输出名。未解析的返回类型和重复投影名保守不猜。
- 当前词中部 / 引用名替换覆盖完整 token，不留下后缀；CodeMirror 的实际 popup / Tab 测试覆盖 bare CTE、带来源列、引用名。候选用 label 做字段匹配、displayLabel 显示限定名，修复 `o.note` 因词中匹配惩罚落在 NO 关键字之后的问题，不靠超出库约定的 boost。
- 关键词检查不再读取整段括号体；元数据列和星号展开纳入 4k 分析预算，超限返回空分析而非分配无界候选。生产 10 ms CST 就绪预算未提高。
- 50 项裸列用例，首轮 30 red / 19 pass；补预算、popup 等覆盖后通过。真实 SQLite 目录中输入 `WHERE amou`，首候选 amount，经 Tab 插入反引号标识符并执行，得到 id=1003、TEXT `1.2300`。属于已加载 SQL 列上下文，不代表完整 DML 列列表、全部星号批量插入或完整 SQL 编译器。

## 第八批：可见工作台改造与动作入口去重

- `51d0ab3` 参考 DBX EditorToolbar / QueryResultViewSwitcher / QueryResultSurface 的分层，落地矩形文档页签、常驻输出面板、结果 / 执行记录 / 执行计划切换、上下 / 左右分栏，以及非模态记录侧栏。不是静态原型，也没有用无实现的按钮充数。
- 第一版曾增加顶部工作区操作栏，造成“新建查询 / 数据对比”等重复，用户截图明确指出混乱；最终已删除整排顶部操作与欢迎页操作卡片。新建查询唯一主入口留左上；对比 / ER / 命令面板归“数据库工具”；一次只展示一个动态运行主按钮，整个脚本归运行选项而不再同时放在更多菜单；事务改为一个状态菜单。动作归属与样式契约见 ACTION-MAP。
- 查询工具按钮统一 28px 高、4px 圆角、固定 13–15px 图标；普通动作低强调，运行高强调。连接 / Schema / 行上限 / 超时 / 布局另行分组，Schema 不重复显示。元数据刷新明确标注“刷新对象树”，不与查询重执行 / 会话重连混淆。右键和快捷键继续共用原动作及权限门控。
- 事务菜单保留真实状态、JDBC manual 语义、capability / busy 门控、重连确认以及 owner 失效。查询、结果、计划在视图切换和最大化时保留已挂载状态；分栏支持键盘调整并清理拖动监听。计划面板不显示之前结果的行数 / 耗时 / 源定位。
- 执行记录来自本轮真实 RPC 结果，客户端往返时间不冒充数据库 cost；按语句展示结果 / 错误与精确源范围，切换结果不重放 SQL。SQLite 实测发现 CREATE VIEW 会携带前一 DML 的 changes 值，本批 UI 不把 DDL / 会话命令的该值当成影响行数；**原生 SQLite driver 的计数本身仍需后续修复**，不宣称后端已改正。
- 记录详情不再遮住整个窗口；与网格当前行双向联动，上下条只在当前页导航，键盘处理限定侧栏，不捕获 SQL 编辑器的方向键。保留 NULL / 空串 / 二进制 / 未知存储元数据，长值只截预览，可交给完整值查看器；大整数 TEXT 和十进制文本不数值化。
- 测试证据：布局 4 red、结果最大化保留 1 red、记录选中行同步 1 red、入口归属 3 red 后逐项修复。中间全量失败包含旧空白页/卸载断言和原中文界面使用英文分组名的旧 fixture，已按真实新交互更新而非删除门禁。最终 `d-unified-build.exit=0`、`d-unified-full.exit=0`：**175 files / 1631 tests，TypeScript / build 通过**。保留既有 act / chunk-size 警告。
- 最终构建 `index-Bjz4G-YJ.js` 在可见 loopback Web + 真实 SQLite 上验收：本地 D-DBX-UI-QA 文件库，2 表 / 1 视图 / 1 外键；两条只读查询各返回 1 / 4 行；执行记录、切换语句、计划、记录侧栏、当前选中行和文档保留可读回。工具菜单真打开 ER（包含视图共 3 个对象节点，1 条关系）；文档页签 ArrowLeft 返回原查询；事务菜单真实 Begin → active → Rollback → idle，过程中未写数据。
- 1440×1000 与 1100×800 检查无 body 横溢出，窄宽工具栏仍约 40.8px 高，各查询控制 28px / 图标 13–15px。最初窄宽被全局 `.btn.sm` padding 挤成小点的问题已修源码并重新构建测量。Dawn / Grove / Amber 有独立视觉检查点；最终恢复 Dawn / 中文、上下布局、空闲事务，预览保留 QA 查询与记录侧栏。
- 证据 `d-unified-browser.json`、`d-unified-review.png`、`d-unified-grove-record.png`、`d-unified-amber-plan.png` 均在忽略日志目录。最终截图用 fullPage CDP；部分导航用了明确记录的 DOM 事件辅助，且旧 native capture 曾滞后。属于真实 Web / SQLite 检查，不是完整 Tauri GUI、全部引擎或三主题所有交互组合验收。
- 本批未改 Rust / Java / 打包配置，未运行或冒称新后端矩阵；没有部署、推送或替换安装版。安装版 / 开发版 / 两个 QA 服务仍在，用户 capabilities.json 原 SHA-256 未变且未提交。

## 第九批：表对象工作区与结构刷新

- `5b62e18` 对照固定 DBX `TableStructureEditor.vue` / `DataGridTableInfoPanels.vue`：将“数据 / 结构 → 列 / 索引 / …”两层导航合为数据、列、索引、外键、触发器、DDL 一排对象页签，支持方向键 / Home / End 与 tabpanel 关联。数据网格与已访问结构视图保留挂载；不同 connId / namespace / table / engine 的元数据、表单和确认不串用。
- 元数据按名称、类型、注释、关联对象等本地筛选，各视图保留独立筛选词和原始序号；显示匹配条目 / 已返回条目。加载、请求错误、空集合、不匹配各有状态；刷新结构不会退到 mock 或复制旧 DDL。添加列只在列视图出现，按钮沿用 28px / 4px 与现有主题 token。非 SQL 对象不展示 SQL 元数据能力。
- DDL 仍由现有元数据重建，新增明确来源说明：并非数据库原始 DDL，不保证完整约束、生成列、索引与引擎属性，不能当作备份 / 迁移脚本。没有把该提示包装成完整结构导出已实现。复制等待真实 clipboard 回执，失败不显示已复制。
- 索引 / 外键 / 触发器确认和请求加入结构 dirty / busy 登记；同步锁防重复确认。多语句 DDL 按真实成功回执计数，失败后禁用整批重放，要求核对状态并刷新结构，不宣称事务回滚。预览或操作进行中不允许刷新覆盖上下文。
- 实际 SQLite ADD COLUMN 后发现 DataGrid 刷新只更新行而沿用旧表头，属于产品缺陷，不是等待时序。新增 red 后修正：服务端列与行、binaryCells 同步更新；表页分页 / 刷新并行读取最新键与注释元数据，失败时保留可读数据但禁止已有行编辑；不使用已移除主键。新父结果不保留旧页表头，移除已经失效的列筛选与排序，仍保留已有草稿的刷新门禁。
- 初始结构测试 10 项失败中，9 项对应交互 / 状态缺口，另 1 项使用了错误英文表单文案，纠正后验证多句失败门禁；对象页签 3 red / 4 pass；网格表头刷新 1 red / 36 skip。中间 build 因测试传入不支持的 ByRoleOptions.exact 失败，修测试类型；最后 `e-final-build.exit=0`、`e-final-full.exit=0`：**176 files / 1648 tests，TypeScript / build 通过**。此前 1644 计数不覆盖后续网格修复；既有 act / chunk-size 提示保留。
- 真实 Web / SQLite：D-DBX-UI-QA 中已有 d_ui_orders 只读检查，amount 筛选为 1/6 且保持第 4 列序号；外键读取 main.d_ui_customers.id；断网刷新显示 Failed to fetch、隐藏旧 DDL 并禁复制，恢复网络后手动刷新成功。未将请求失败误判成空结构或重放写入。
- 仅在同一本地隔离库创建 e_structure_probe（初始化一次）：2 行长数字 / 十进制 TEXT；实际走预览 / 确认添加 qa_note，再按名称确认删除 e_structure_probe_amount 索引，重读为 0/0。最终新构建 `index-hB9Q_Z0u.js` 另加不同的 qa_after_refresh 字段验证修复：网格刷新前 3 列、刷新后 4 列，主键重新加载、原两行 `900719925474099312345` / `1.2300` 与新字段 NULL 保持正确；不是重复执行旧建表脚本。
- 最终前台原生键盘验证 End → DDL、Home → 数据、ArrowRight → 列；1440×1000 / 1100×800 无 body 横溢出，窄屏结构表在自己的滚动区滚动，工具按钮 28px / 图标 14px。本增量实际检查 Dawn / Amber / Grove 的独立界面检查点，最终读回确认恢复 Dawn / 中文；不代表三主题所有交互组合均已验收。
- 证据在忽略目录：`e-object-browser.json`、`e-object-workspace-dawn-final.png`、`e-structure-amber-1100.png`、`e-structure-grove.png`、`e-grid-refreshed.png`。部分导航用 DOM 事件辅助；多语句网络不确定写 / 在途关闭保护为确定性组件测试，不冒称真实破坏性网络写验证。未改 Rust / Java / 安装包，未部署、推送或改动用户 capabilities.json。

## 后续仍需实施 / 补齐验收

1. 当前语句 / 选区 / 全脚本、上下文菜单、搜索、结构速览、有界作用域诊断与基本相关 / lateral 补全已实现上述路径；继续补完整列级 / 语义诊断、DML 列列表与批量星号插入、复杂表函数和前向 CTE 列推导、server version / SQL_MODE / 扩展 / 重载、过程批次 / 大脚本及全部桌面键盘门禁，不把有界推断称为完整 SQL 编译器。
2. 临时预览 / 固定、草稿保护、字段树、去重动作栏、双向分栏、执行记录、记录侧栏及表对象单层导航 / 结构筛选 / 刷新已有上述检查点；继续统一导入导出向导 / 原生工作区。原始 DDL 保真读取、约束 / 分区 / 生成列等完整元数据、更多方言结构编辑及 SQLite 安全重建仍缺，不能以本批浏览器 ADD COLUMN / DROP INDEX 样例代替。任务持久化、跨组件元数据失效串联及逐主题 / desktop 完整验收继续保留。
3. 已有结果 / 计划的源 SQL 定位与独立输出视图；更多引擎、字段血缘与真实优化依据仍待实施。SQLite `stmt.execute` 对 DDL / 会话命令继承旧 changes 的原生计数问题也需独立修复和回归，本批只修正 UI 的计数展示边界。
4. SQL 文件已有有界读取、严格解码、预检暂存、真实驱动取消及有界 Web 上传；仍需持久化任务 / 断网与进程重启后的回执恢复、大于 8 MiB 的 Web 分块上传、其他编码 / 方言、逐驱动取消验收，以及全范围导出 / 迁移 / 一致性。取消是否能打断正在运行的语句仍取决于驱动；不支持时只能等待当前语句真实返回。
5. Mongo / Redis / ES / DuckDB 原生工作区与完整 AI 工具预览审批维护闭环。文件型连接的新建和手动重连入口已改善，但不是 Parquet/CSV/JSON 文件工作流或所有原生数据库工作区已完成。

原型能点击、菜单已出现、测试数量增加都不能代替这些未完成能力。
