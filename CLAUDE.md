# CLAUDE.md

## 开发规范

### Git 提交规范
- 每一次功能新增、bug 修复或优化都必须提交 git 进行跟踪
- 提交信息使用语义化前缀：`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `chore:` 等
- 提交信息（注释正文）使用中文撰写，语义化前缀保持英文原文
- 提交粒度适当，一个提交对应一个逻辑变更

### 国际化 (i18n)
- 所有新增页面必须支持国际化
- 新增文案时需同步更新所有语言文件

### 主题色切换
- 所有新增页面必须支持主题色切换

### 沟通语言规范
- 思考过程（thinking）和对话回复始终使用中文，专业术语（如 API、commit、TDD、abort、UUID 等）保持英文原文，不强行翻译

### 参考项目优先级
- 所有涉及 SSH、SFTP、隧道代理、端口转发之类的需求，优先参考 [Reach](https://github.com/alexandrosnt/Reach) 项目的逻辑实现
- 所有跟数据库相关的需求，优先参考 [dbx](https://github.com/t8y2/dbx) 项目的逻辑实现
- 仅当上述两个项目中都找不到可参考的实现时，才从 GitHub 搜索其他相关的高星项目作为参考

## 编码行为准则

> 参考 [andrej-karpathy-skills/CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md)，用于减少常见的编码错误。

### 1. 先思考，再动手 (Think Before Coding)
- 不臆测、不隐藏困惑、把权衡摆到台面上（Don't assume. Don't hide confusion. Surface tradeoffs.）
- 遇到多种可理解的方案时，不要默默选一个，而应列出选项并提出澄清问题
- 澄清要前置——在动手前提出，而不是出错之后再补救

### 2. 简单优先 (Simplicity First)
- 只写能解决问题的最少代码，不做任何投机性、预留性的设计（Minimum code that solves the problem. Nothing speculative.）
- 实现前后都要自问：是不是把问题搞复杂了？如果是就简化

### 3. 外科手术式改动 (Surgical Changes)
- 只动必须动的地方，只清理自己制造的麻烦（Touch only what you must. Clean up only your own mess.）
- 匹配现有代码风格，避免与本次需求无关的重构

### 4. 目标驱动执行 (Goal-Driven Execution)
- 动手前先定义成功标准，完成后通过测试验证
- 把模糊的需求转化为可度量的结果，用带有明确验证检查点的多步计划推进
