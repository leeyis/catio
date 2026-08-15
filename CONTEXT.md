# Catio Agent Knowledge

本上下文定义 Catio Agent 在长期知识沉淀、反思和技能演进中的核心语言，用于区分可复用流程、事实记录与尚未审核的建议。

## Language

### Agent Runtime

**Conversation（对话）**:
用户与 Agent 之间可持续、可恢复的交互线程；包含多个按顺序发生的 Turn。
_Avoid_: Agent Session、SSH Session

**Turn（轮次）**:
由一次用户提交触发，覆盖其后全部模型响应、工具调用和最终结果的完整交互周期。
_Avoid_: 消息、步骤、Session

**Tool Use（工具意图）**:
模型提出的结构化工具调用请求；它描述准备执行的操作，但本身不表示操作已经发生。
_Avoid_: 命令结果、工具执行

**Approval（审批）**:
针对一个 Tool Use 是否允许继续执行的明确决策；审批通过不代表执行成功。
_Avoid_: Tool Result、执行确认

**Tool Result（工具结果）**:
与一个 Tool Use 唯一配对的终态结果，包括成功、失败、拒绝、取消或结果未知。
_Avoid_: Approval、终端输出

**Target Ref（目标引用）**:
Turn 中工具操作所指向的 SSH PTY、本地终端、数据库连接或其他运行目标的稳定引用。
_Avoid_: Session、Connection

**Outcome Unknown（结果未知）**:
系统已停止等待或请求取消，但无法证明目标侧副作用已经停止时使用的工具终态。
_Avoid_: Cancelled、Failed

### Knowledge

**Skill（技能）**:
经用户认可、可由 Agent 检索和遵循的可复用操作流程；包含适用条件、参数、步骤、风险与验证方法。
_Avoid_: 片段、宏、记忆

**Candidate Skill（候选技能）**:
由反思或用户手动触发产生、尚未通过审核的技能草稿；不会进入 Agent 的可用技能集合。
_Avoid_: 自动生成的技能、未发布技能

**Candidate Revision（候选修订）**:
针对某个已发布技能提出的新版本，以差异形式等待用户审核。
_Avoid_: 自动更新、覆盖

**Published Skill（已发布技能）**:
已经用户审核并发布、可以进入 Agent 上下文的不可变技能版本。
_Avoid_: 已审核候选、当前草稿

**Reflection（反思）**:
任务结束后基于步骤、结果和验证证据进行的异步分析，用于解释问题与解决方法，并判断是否值得形成候选技能。
_Avoid_: 总结、自主发布

**Skill Evolution（技能演进）**:
通过候选修订、用户审核和版本发布逐步改善技能的受控过程。
_Avoid_: 自我修改、静默学习

**Memory（记忆）**:
可检索的事实、偏好、问题案例或结果记录；记忆描述已知信息，不代表一套可执行流程。
_Avoid_: 技能、历史

**Global Skill（通用技能）**:
经过参数化、可在同一用户的多个兼容目标上复用的技能。
_Avoid_: 系统技能、共享技能

**Target-specific Skill（目标专属技能）**:
绑定特定 SSH 主机、数据库连接或其他目标，只能在该目标上下文中使用的技能。
_Avoid_: 私有技能、本地技能
