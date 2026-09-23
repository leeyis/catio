# Windows 离线诊断

适用于“窗口消失但 catio.exe 仍在”、界面空白、无法打开界面或异常退出。
启动后界面自动消失、catio.exe 和托盘仍在，也可能是 WebView2 故障、原生窗口异常或
事件循环失去响应，不能直接判定为用户关闭到托盘。需按下面步骤保留现场。

## 先收集现场（包括旧版 0.7.1）

将本目录的 `collect-windows-diagnostics.ps1` 拷到故障机器。在**故障发生后、结束进程前**执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\collect-windows-diagnostics.ps1
```

ZIP 默认保存到桌面，也可通过 `-OutputDirectory C:\Support` 指定输出目录。
无需联网或管理员权限，不安装软件、不修改应用状态、不上传文件。
执行策略选项仅对这次 PowerShell 进程生效；组织策略禁止执行脚本时应联系管理员。

包含：Windows 版本/build、Catio/WebView2 进程是否响应、主窗口是否存在，Catio 顶层
窗口可见/最小化状态和坐标、已安装 WebView2 版本、最近七天应用崩溃的受限字段，
以及下面列出的 Catio 诊断日志（若存在）。其他应用的 WebView2 进程也可能出现在清单里。
旧版没有新增运行日志时，仍可利用进程和窗口信息排查。

不收集：连接配置、凭据、浏览器存储、终端输出、SQL、环境变量、进程命令行、窗口标题、
内存 dump、MCP 业务日志或完整 Windows 事件消息。分享前仍请检查 ZIP。

## 新版运行日志

正常路径：`%LOCALAPPDATA%\io.catio.app\logs`。
路径不可写时，运行日志回退到 `%TEMP%\io.catio.app\logs`。
托盘菜单「打开诊断日志 / Diagnostic logs」可以直接打开实际路径，不依赖 React 页面。

- `catio-runtime.log`：启动版本/平台/PID、WebView2 版本、页面加载、React 就绪、异常分类、
  应用栈位置、失败的调用名称、窗口隐藏/恢复、WebView2 故障以及正常退出。
  启动后第 1、3、10、20 秒记录原生窗口与 WebView2 状态，即使 React 已就绪仍会采样。
- `catio-panic.log`：Rust panic 的代码位置和回溯；在 abort 之前同步写盘。
- `catio-diagnostics.log`：原有 terminal/agent 状态日志。
- 每份日志最大约 5 MiB，保留一份 `.log.1` 轮转备份。

异常日志只记录标准错误类型、分类、代码位置和系统错误码。任意错误文本或拒绝对象可能
包含秘密，因此不会原样持久化；调用参数、返回值、命令和终端内容也不会进入运行日志。

## 判断方向

- `window-close-to-tray` → `window-hide`：应用收到关闭请求后隐藏窗口。
- `window-restore-complete`：查看 `visible`、`minimized`、`position`、`size`；失败的 show/focus 操作单独记录。
- `window-missing`：托盘仍在但主窗口对象不存在。
- `startup-window-state`：启动过程的窗口存在性、可见性、最小化状态、尺寸和位置；
  `startup-webview-state` 记录 WebView2 控件可见性及浏览器进程 PID。
- 有 `startup-probe` 却没有对应秒数的 `startup-window-state`，或 `elapsedMs` 明显滞后：
  主线程可能阻塞；先结合后续记录确认是否只是启动缓慢。
- `webview-close-requested`：WebView2 收到了页面的关闭请求，与原生窗口关闭事件分别记录。
- `webview-navigation-completed`：页面导航是否成功及 WebView2 数值错误码，不记录 URL。
- `webview-process-failed`：WebView2 原生故障，`kind` 为 WebView2 的 ProcessFailedKind 数值
  （0 浏览器进程退出，1 渲染进程退出，2 渲染无响应，3 子框架退出，6 GPU 进程退出）。
- `frontend-ready-timeout`：20 秒内未收到 React 挂载就绪，结合同一时间的窗口采样、page-load、resource-error、javascript-error 排查。
- `react-error`：应用渲染失败；页面提供重新加载和日志入口。
- `rust-panic`：原生 Rust panic，结合代码位置/回溯排查。

界面无法操作时，可以在保存现场 ZIP 后使用托盘「重新加载界面 / Reload UI」。
它会重载页面，当前未保存的编辑和前端临时状态可能丢失。

Edge 浏览器版本不等同于 WebView2 Runtime 版本。内网机器应使用微软官方 WebView2
Evergreen Standalone Installer 的 x64 离线包维护运行时：
https://developer.microsoft.com/microsoft-edge/webview2/

进程被任务管理器强制终止、系统断电、早于 Rust 入口的 DLL 加载失败等无法由 panic hook
捕获；日志缺少退出事件不单独证明崩溃，需要结合 ZIP 中的系统事件和进程状态。
