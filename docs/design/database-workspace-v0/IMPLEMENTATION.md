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

## 后续仍需实施 / 补齐验收

1. 当前语句 / 选区 / 全脚本、上下文菜单、搜索和显式结构速览已实现本批路径；继续补方言/过程批次/大脚本预算与全部桌面键盘门禁，不把有界推断称为完整 SQL 编译器。
2. 临时预览 / 固定、草稿保护和字段树已实现本批路径；继续补所有结构类型层级、任务持久化、各入口及逐主题/desktop 完整验收。
3. 已有结果 / 计划的源 SQL 定位；更多引擎、字段血缘与真实优化依据仍待实施。
4. 导入导出 / 迁移的大文件 I/O、任务与授权、真正取消 / 核验 / 一致性。
5. Mongo / Redis / ES / DuckDB 原生工作区与完整 AI 工具预览审批维护闭环。文件型连接的新建入口已改善，但已有 profile 重连仍经过通用密码提示，这不应算作原生文件工作流已完整交付。

原型能点击、菜单已出现、测试数量增加都不能代替这些未完成能力。
