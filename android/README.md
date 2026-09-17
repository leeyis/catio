# Catio 虫洞 · Android 接收端

基于 [CameraFileCopy](https://github.com/sz3/cfc) v0.6.8 的 Catio 定制版。用手机相机接收另一块屏幕上的 CIMBAR 动态码，无需手机与发送设备建立网络连接。

## 使用

1. 安装测试 APK，开启相机权限。
2. 将 Catio 安装目录中的 `catio.conf`（macOS 为 `Catio.app` 旁） 中 `Experiment_func` 改为 `1` 并重启；在 Catio 设置中解锁“实验性功能”；在 SFTP 中右键一个不超过 5 MiB 的普通文件，选择“打开虫洞”并播放。
3. 让完整动态码进入画面，可双指或使用滑杆缩放，点按动态码进行区域对焦。观察接收速度、有效识别率和位置提示；必要时点按预览重新对焦。
4. 完成的文件自动保存在“文件”页，可打开、另存、分享或删除。取消另存、另存失败不会删除接收的原文件；同名文件自动编号。
5. 要开始新的接收或再次接收同一文件，点击接收页暂停按钮旁的“重置接收”。当前未完成进度、识别状态及完成记录会清空，并立即继续接收；已保存的文件不受影响。同名文件依次保存为 `文件名 (1).扩展名`、`文件名 (2).扩展名`，无扩展名也会编号。重置前可先切换发送文件，避免再次接收到仍在播放的旧文件。

接收速度是最近约 3 秒去重后的有效码流速率，包含纠错恢复所需的数据，不能直接等同于原文件大小除以耗时。识别率是采样窗口内成功解码帧占已处理帧的比例。进度表示已收集的块，完成发布前最多显示 99%；预计剩余时间仅供参考。

只有定位点完整且新鲜时才给出方向、距离或倾斜建议；无法识别时会提示完整入镜和减少反光，不会猜测角度。暂停、切后台和短暂丢失画面会保留当前进程中的接收数据；退出应用或系统结束进程后，未完成进度不持久化。完成的文件会一直保留，卸载或清除应用数据会删除它们。

## 保留的原有功能

- 自动识别和 B / Bm / Bu / 4C 固定模式。
- 手机离线发送：统一的“发送”Tab，只需选择文件，使用默认 B 模式与最高 30 fps 播放。接收端的固定模式仍在“选项”中。
- 同时接收多个传输流，原版纠错与 fountain 编码协议。

界面使用 Catio 奶油猫图标及 Dawn / Amber 配色，跟随系统浅色/深色模式，支持中文、英文及横竖屏。应用只请求相机权限，没有 INTERNET 权限；已接收文件置于应用私有目录，不参与系统云备份或设备迁移。用户主动分享或另存时，目标应用/存储服务由用户选择。

Catio 桌面发送端执行 5 MiB 上限；手机发送使用 128 MiB 内存保护上限，接收端单文件解压输出设有 512 MiB 保护上限。协议保留原有纠错和 Zstd 格式校验，没有额外增加身份认证或文件加密。

## 构建

- JDK 17、Android SDK platform 36、NDK 27.2.12479018、CMake 3.22.1。
- OpenCV 4.12.0 Android SDK，解压后包含 `sdk/native` 和 `sdk/build.gradle`。
- Gradle wrapper 8.14.3 / Android Gradle Plugin 8.11.0。
- 最低 Android 5.0（API 21）；APK 包含 arm64-v8a 和 x86_64。32 位 ARM 设备不包含在本次构建中。

```sh
# 编码器资源已纳入仓库，无需初始化子模块。
cd android
# local.properties 不提交：按本机实际目录填写
# sdk.dir=/path/to/Android/sdk
# opencvsdk=/path/to/OpenCV-android-sdk
./gradlew :app:assembleDebug
```

也可用环境变量 `OPENCV_ANDROID_SDK` 或 Gradle `-Popencvsdk=...` 指定 OpenCV。初次构建需联网下载构建依赖，安装后的收发功能可离线运行。

输出：`app/build/outputs/apk/debug/CatioReceiver-debug.apk`。交付到 `artifacts/` 的 APK 是 debug 签名测试包，不是商店发布签名。正式发布需要配置由项目所有者保管的签名密钥。

## 验证

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug
# 指定已启动的独立模拟器或测试设备
ANDROID_SERIAL=emulator-5584 ./gradlew :app:connectedDebugAndroidTest
# 桌面 C++ 存储校验，需要 C++17、pkg-config 和 libzstd
bash scripts/test-native-store.sh
```

`ReceiverInteropTest` 使用 Catio 桌面实际 v0.6.8 WASM 编码器生成的图片，走 Android JNI / OpenCV / fountain / Zstd 整条接收链路，逐字节比对结果，并验证自动模式、重复帧计数和 Unicode 文件名。固定数据及 SHA-256 在 `app/src/androidTest/assets/interop/manifest.json`。

要重新生成夹具，在 Catio 仓库根目录启动 Vite，再运行（Node 需可加载 Playwright，且已安装 Chromium）：

```sh
CATIO_URL=http://127.0.0.1:1420 node scripts/generate-interop-fixture.cjs
```

模拟器验证不替代真机相机、屏幕摩尔纹、不同亮度/刷新率和实际吞吐测试。详细结果及对抗评审见 [docs/REVIEW.md](docs/REVIEW.md)。

## 来源与许可证

- CameraFileCopy：`sz3/cfc`，基线 commit `e143ebd16154f3db17fbfdf8d0da71b1b50678a4`，保留原有 MIT LICENSE。
- libcimbar：仓库内原有 subtree，v0.6.8，MPL-2.0 及各依赖许可证均保留。
- 离线编码器资源：`sz3/cimbar-js-bits`，commit `d617b9027670f23d35777501f630e49e8cf14476`。构建时校验 WASM SHA-256，品牌样式放在独立 `catioAssets`，不修改上游 WASM 引擎。
- OpenCV 4.12.0 及依赖 notices 已打包；在“选项 → 使用帮助与开源许可”可离线查看。
- 原项目介绍见 [README.upstream.md](README.upstream.md)。Catio 奶油猫品牌资源来自本地 Catio 仓库。

## 0.2.1 接收重置

接收页新增“重置接收”，与暂停/继续按钮并排；重置后退出暂停、清空完成提示和本次接收状态，恢复接收，保留缩放设置及已保存文件。“选项”内的重置也使用相同逻辑。

同一传输在一次接收会话中仍只保存一次，避免发送端循环播放时不断生成副本。主动重置后可以再次接收相同文件，按括号序号保存；它也可用于丢弃未完成进度后开始新的接收。相关回归测试使用真实按钮驱动 JNI 解码链路，验证连续三次接收同一文件与原件保留。

本次测试与对抗复查见 [0.2.1 复审记录](docs/REVIEW-0.2.1.md)。

## 0.2.0 改进与性能范围

- 接收、发送、文件统一使用图文底部导航；接收只保留暂停/继续主操作，已接收文件支持打开、另存、分享与确认删除。
- 硬件支持时提供 1–4× 缩放、点按区域对焦、连续自动对焦恢复和超时恢复；缩放范围以手机公开的相机能力为准。数字缩放不能创造原本不存在的光学细节。
- 优先选择相机公开支持的 30–60 fps 预览范围；编解码协议保持兼容。
- 解码器在复制帧前限制在途数量；成功识别后优先扫描附近区域，定位失败立即回到全图，低频尝试局部阈值。每帧仍重新检测定位点并计算透视，避免复用旧矩阵导致手持移动后采样错误。
- 桌面与手机发送默认上限由 15 调至 30 fps，受实际屏幕和浏览器性能限制。

用户反馈的旧版基线为 **OnePlus 6，约 70 KB/s**。200 KB/s 是优化目标，尚没有该手机新版实拍结果，不保证普通手机在任意距离或角度达到此值。测试图像、模拟器吞吐和理论发送容量不能替代实际光学链路测速。见 [性能说明](docs/PERFORMANCE.md)。
