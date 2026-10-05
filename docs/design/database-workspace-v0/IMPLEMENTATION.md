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

## 后续仍需实施

1. 真正语句范围、编辑器上下文 / 右键、搜索与结构 peek，完成编辑器完整门禁。
2. 对象临时预览 / 固定与脏草稿保护、对象树字段 / 完整元数据层级与全部入口。
3. 查询结果 / 计划 / SQL 联动、更多引擎、字段血缘与真实优化依据。
4. 导入导出 / 迁移的大文件 I/O、任务与授权、真正取消 / 核验 / 一致性。
5. Mongo / Redis / ES / DuckDB 原生工作区与完整 AI 工具预览审批维护闭环。

原型能点击、菜单已出现、测试数量增加都不能代替这些未完成能力。
