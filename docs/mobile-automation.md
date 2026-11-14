# 移动交互与设备自动化

Flutter Pilot 提供两个通道：Flutter Debug VM 负责 Widget 结构和定位；插件托管的 Appium 负责 Android、iOS 的系统输入、原生页面、键盘及权限弹窗。VM 基础操作及 Flutter App 截图可独立使用，需要系统输入或原生／系统界面时才准备设备通道。当前源码共有 51 个 MCP 工具和 59 个 Prompts：每个工具有同名模板，另有四个能力入口和四个场景模板。

初始化说明按用户任务介绍功能，`capabilities` 与 `get_usage_guide(topic="overview")` 提供同一份功能映射；六个指南主题为 `overview`、`screenshot`、`http`、`ws`、`ui`、`workflow`。只读查阅和状态查询不安装环境、不连接设备、不执行 UI；完整 Prompt 通过 `prompts/get` 按需读取。客户端决定如何使用说明，不能保证服务端能强制 Agent 路由。

## 准备与连接

在工作台 MCP Tab 的「设备自动化」区域刷新设备、准备环境，选择明确的设备 ID，填写 App 包名／Bundle ID，再连接。App 应由自己的 Debug 入口预先启动。刷新只检查，不下载；安装仅由「准备自动化环境」或 `setup_automation` 触发。准备和连接期间可查看进度、诊断并取消。

插件私有安装固定 Appium **3.9.0**、UiAutomator2 **8.7.3**、XCUITest **12.22.8**，使用 `resources/automation/package-lock.json`、独立安装目录及 `APPIUM_HOME`，不调用全局 Appium。复用 Node 20.19+、22.12+ 或 24+，npm 10+。Android 需要 SDK Platform Tools、JDK 17+、已启动模拟器或完成 USB 授权的真机；iOS 需要 macOS、Xcode、已启动模拟器，真机还需配对、信任和开发者模式。

初次准备最多十分钟；安装在新目录完成并检查驱动和连接适配器后才原子切换。取消会终止并等待本轮安装进程退出，删除未完成目录；失败保留之前的安装指针和可用版本，可重新准备。查询状态不会重试安装。

连接适配器现为 v3，启动阶段也会跳过卸载其他工具的 WDA。旧 v2 安装会显示未准备，需重新执行「准备自动化环境」。MCP 的准备／连接调用分别允许 660／240 秒，宿主期限比桥接客户端多 5 秒；外部 MCP 客户端也需为这两类调用配置足够的超时。

MCP 调用顺序如下，所有有目标的工具必须传入从 `list_sessions` 选择的项目 `sessionId`：

```jsonl
{"tool":"get_automation_status","arguments":{"sessionId":"project"}}
{"tool":"setup_automation","arguments":{"sessionId":"project"}}
{"tool":"connect_device","arguments":{"sessionId":"project","deviceId":"设备ID","appId":"com.example.app"}}
```

IDE 调试会话提供的设备 ID 用于绑定 VM。手动输入 VM 地址时，需要在工作台明确勾选「当前 VM 来自所选设备」，或在 `connect_device` 中提供与 `deviceId` 相同的 `vmDeviceId`。转换 Flutter 坐标前还会检查 VM PID、目标 App 进程、前台应用、原生覆盖层、窗口、方向及布局；无法确认时返回明确错误。设备原生选择器和显式设备坐标不依赖 VM。

连接已有应用时使用 noReset、autoLaunch=false，不清数据、不重新安装目标 App、不自动重启、不接受或关闭权限弹窗。WDA／UiAutomator2 辅助服务由设备驱动准备，和目标 App 安装区分。插件托管的 XCUITest 连接适配器跳过模拟器启动／偏好修改，以及不属于本插件的 XCTest 进程清理；仅通过自身 WDA 对象和所启动进程清理资源。Appium 仅监听 `127.0.0.1`，WDA、MJPEG 和 Android 转发使用单独本机端口。

### iOS 真机 WDA

用户先完成签名、信任、配对及开发者模式。连接时提供已签名 `WebDriverAgentRunner-Runner.app` 的绝对路径和实际 Bundle ID：

```json
{
  "sessionId": "project",
  "deviceId": "真机UDID",
  "appId": "com.example.app",
  "wdaPath": "/absolute/path/WebDriverAgentRunner-Runner.app",
  "wdaBundleId": "com.example.WebDriverAgentRunner"
}
```

驱动使用预签名 WDA，不自动选择签名团队、创建证书或访问钥匙串。WDA 可作为自动化辅助 App 部署，目标业务 App 保持原有安装和数据。Xcode、系统版本、WDA 签名或设备接入失败在诊断中呈现；缺少真机与有效签名不能算验收通过。

## 定位规则

旧 `key`、`ancestorKey` 保持兼容，支持精确 `ValueKey<String>`／`ValueKey<int>`。也可以明确提供 `selector`：

```jsonl
{"sessionId":"project","selector":{"text":"登录","type":"Text","ancestor":{"key":"login.page"}}}
{"sessionId":"project","selector":{"semantics":"搜索入口"}}
{"sessionId":"project","selector":{"source":"device","accessibilityId":"confirm"}}
{"sessionId":"project","selector":{"source":"device","resourceId":"com.example.app:id/submit","type":"android.widget.Button"}}
```

Flutter 支持 `key`、`text`、`semantics`、Widget `type`、`ref` 和 `ancestor`；设备支持 `accessibilityId`、`resourceId`、原生 `text`、控件 `type`、`semantics`、`ref` 和 `ancestor`。文字和类型等条件匹配节点本身；所有提供的条件按 AND 组合。原生字段不能和 Flutter Key 混用。优先使用稳定 Key，但查找失败不会自动改成文字或坐标。一个操作只能指定一种目标；多个匹配返回候选摘要，进一步限定后再操作。

`get_ui_snapshot` 的 `source` 为 `flutter`（默认）或 `device`。快照返回节点类型、文字、语义、层级引用、启用／可见／可操作状态、边界及可执行动作；唯一 Flutter 输入框还包含焦点、文本长度和选区状态。Flutter 快照包含当前挂载树中的相关节点；未挂载列表项需滚动查找。原生快照覆盖系统界面、权限弹窗与键盘，敏感输入内容不返回。

```jsonl
{"sessionId":"project","source":"device","maxNodes":300}
{"sessionId":"project","selector":{"ref":"device:当前快照ID:节点序号"}}
```

`ref` 只属于生成它的会话和快照。新快照、设备源变化、Flutter 节点重建或边界／文本变化后旧引用会失效。重连、热更新、旋转、导航或布局变化后重新定位。

## 输入后端与坐标

动作支持 `backend: auto | flutter | device`。auto 默认在已连接设备时发送系统输入，否则使用 VM；指定 device 但未连接时直接报错。设备输入失败不会切换成 VM 重放。Flutter 精确文本编辑通过编辑协议执行，并在结果中返回实际 `backend` 与 `inputMethod`。

`point: {x,y}` 是显式目标。Flutter 后端以 Flutter 逻辑像素为单位；设备后端以 WebDriver 当前窗口的坐标单位为准，iOS 通常为 point、Android 通常为像素。设备截图附图片尺寸、方向与窗口坐标；图片像素不能直接当作输入坐标。转换 Flutter 目标时要求窗口比例一致，原点和系统栏可确认，定位前后布局／方向稳定。原生窗口无法证明映射时拒绝输入，可通过 `connect_device.viewport` 提供经过独立核验的 Flutter 窗口矩形。旋转后旧校准必须重新核验。

```json
{ "sessionId": "project", "point": { "x": 120, "y": 260 }, "backend": "device" }
```

## 交互能力

| 类别 | 工具与参数                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 点击 | `tap`、`double_tap`（`intervalMs`）、`long_press`（`durationMs`）                                                             |
| 手势 | `drag`（`to`、`holdMs`）、`swipe`（方向、距离）、`pinch`（`scale`、`radius`）、`rotate_gesture`（角度、半径）                 |
| 多指 | `perform_gesture`：1–5 指显式坐标轨迹，共同起止时间，最多 120 个时间点、10 秒                                                 |
| 滚动 | `scroll`：明确区域、四向、距离、持续时间；`targetSelector` 或旧 `targetKey` 有界查找，最多 30 步                              |
| 文本 | `enter_text`：`mode=replace`／`append`；`edit_text`：清空、删除、光标、选区、全选、复制、剪切、粘贴                           |
| 键盘 | `press_key`：命名按键、单字符、修饰键；`get_keyboard_state`、`hide_keyboard`、`editor_action`                                 |
| 系统 | `device_action`：back、home、foreground、background、notifications、control_center、close_panels、rotate、restore_orientation |
| 验证 | `wait_for_widget`：present、absent、visible、enabled、actionable、text_equals、text_contains、text_changed                    |
| 截图 | `take_screenshot`：Flutter screen／long；device 仅 screen，包含系统 UI                                                        |

用户要求当前 Flutter App “截图”“截屏”“screenshot”或布局对比时，优先调用 Flutter Pilot 的 `take_screenshot`。普通 App 截图用 `source=flutter,mode=screen`，无需 Key、Scene、Mock 或 Appium；无需先读 UI 树，也不重启或导航页面。截图对象是桌面、浏览器网页或其他目标时使用对应工具；上下文无法确定对象时先澄清。

长图使用 `source=flutter,mode=long`，先 `list_screenshot_targets`；多个候选必须明确 `targetId`，仅一个候选可省略。长图会实际滚动，结束时尝试恢复原位置；失败、超限或恢复异常按真实结果报告，不能把局部图当作完整成功。需要系统键盘、权限弹窗或系统 UI 的整屏时，先确认目标设备绑定，再用 `source=device,mode=screen`；设备截图不支持 long。详细边界见 [MCP 截图指南](mcp.md#app-截图) 或 `app_screenshot` Prompt／`screenshot` 离线指南。

```jsonl
{"tool":"take_screenshot","arguments":{"sessionId":"project","source":"flutter","mode":"screen"}}
{"tool":"list_screenshot_targets","arguments":{"sessionId":"project"}}
{"tool":"take_screenshot","arguments":{"sessionId":"project","source":"flutter","mode":"long","targetId":"从 list_screenshot_targets 获取"}}
{"tool":"take_screenshot","arguments":{"sessionId":"project","source":"device","mode":"screen"}}
```

手势通过同一有界轨迹执行器发送真实系统输入或 Flutter pointer 事件，不直接调用按钮、路由或业务回调。`swipe.direction` 为手指方向，`scroll.direction` 为内容查找方向。嵌套滚动必须明确指定子区域，查找目标限制在该区域的后代中；Flutter 区域与原生目标需属于同一界面树。设备触摸滚动后读取 Flutter 滚动状态，等待惯性停止后再检查目标。

```jsonl
{"tool":"drag","arguments":{"sessionId":"project","key":"item.1","to":{"key":"item.3"},"holdMs":600,"durationMs":700}}
{"tool":"pinch","arguments":{"sessionId":"project","key":"map","scale":1.5}}
{"tool":"scroll","arguments":{"sessionId":"project","selector":{"type":"Scrollable","ancestor":{"key":"outer"}},"direction":"right","targetSelector":{"text":"第八项","type":"Text"},"maxSteps":10}}
{"tool":"perform_gesture","arguments":{"sessionId":"project","backend":"device","fingers":[{"points":[{"x":100,"y":200,"timeMs":0},{"x":80,"y":200,"timeMs":600}]},{"points":[{"x":180,"y":200,"timeMs":0},{"x":200,"y":200,"timeMs":600}]}]}}
```

Flutter 精确编辑通过 `EditableTextState` 编辑协议，保持 formatter／`onChanged`。光标／选区 offset 使用 Dart UTF-16 索引，必须位于完整字符簇边界；位于 emoji、组合重音或 ZWJ 序列内部时返回 `INVALID_TEXT_BOUNDARY`，不改变焦点和选区。删除基于完整原字符串的字符簇边界，支持合法反向选区。

追加文本显式使用 `backend=flutter`。设备通道无法可靠确认末尾光标，`mode=append` 在发送输入前返回 `UNSUPPORTED_OPERATION`，能力项 `enter_text.append` 为 false；原生替换保持可用，原生精确光标和选区也明确返回不支持。iOS 的全选、复制、剪切和粘贴使用可见的中英文编辑菜单，点击前核验活动编辑器属于目标字段，并复核已有 Flutter 选区；无法确认时返回 `EDIT_TARGET_UNCONFIRMED`，不点击菜单。其他语言需通过设备快照显式操作。

硬件方向键和组合键通过 XCTest typeKey 执行，依赖系统版本、App 和硬件键盘设置；API 不可用时明确报错并更新分项能力，不修改模拟器全局偏好。复制、剪切、粘贴使用当前平台剪贴板，密码框不导出文本。中文输入覆盖业务文本，未覆盖输入法候选测试。

```jsonl
{"tool":"enter_text","arguments":{"sessionId":"project","key":"search","text":"中文","mode":"append","backend":"flutter"}}
{"tool":"edit_text","arguments":{"sessionId":"project","key":"search","action":"select_range","start":0,"end":2}}
{"tool":"editor_action","arguments":{"sessionId":"project","action":"search"}}
{"tool":"wait_for_widget","arguments":{"sessionId":"project","selector":{"key":"result"},"state":"text_equals","text":"完成","timeoutMs":5000}}
```

权限弹窗先读取 device 快照，再明确点击唯一按钮。iOS back 需要可见返回按钮选择器或显式边缘返回手势，不直接调用 Navigator。Android 不支持 iOS 控制中心；方向改变可能受 App 限制，返回未确认时检查实际界面。`get_automation_status` 按当前平台、设备及动作列出能力和具体不支持原因；协议可调用不代表已经在每种设备验收。

## 排队、取消及结果验证

同一个工作区的 VM 与设备动作统一排队。跨工作区、IDE 的同一设备使用独占租约；同一设备一次仅允许一个连接。租约位于 `~/.flutter-pilot/automation/leases`。崩溃后不冒险自动抢占：诊断提供持有 PID 与目录，确认原进程及设备服务完全退出后再手动清理。

Flutter 长截图会滚动页面，始终按实际 VM 设备获取租约，即使设备输入通道连接的是另一台设备。仅在当前原生连接已持有同一 VM 设备租约时复用。

取消、超时和断连会使 VM 会话失效，并释放本插件的输入源。iOS 的 W3C releaseActions 是驱动空操作，因此已发出的有界手势需等待原生执行返回或时限结束；不会立即重放或开始下一次输入。动作已发送但结果未确认时 `uncertain=true`，先查快照、状态和本次新网络记录。`dispatched=true`／`verified=false` 仅说明输入已送达，不代表业务成功。

断开只删除当前会话、停止本插件的本机服务和测试进程、释放自己的租约，保留目标业务 App。不会删除其他 Appium 会话。工作台关闭后设备通道可继续使用，退出对应工作区时清理。

## 验证与边界

独立 fixture 命令（只对专用测试设备使用，会重新创建测试 App）：

```sh
AUTOMATION_TEST_DEVICE='<专用模拟器UDID>' \
AUTOMATION_TEST_PLATFORM=ios AUTOMATION_TEST_NATIVE=1 \
AUTOMATION_RUNTIME_DIR='/tmp/flutter-pilot-automation-validation' \
npm run test:automation:flutter
```

未设置 `AUTOMATION_TEST_NATIVE=1` 时只验证 VM。可用 `FLUTTER` 指定 Flutter 二进制；脚本输出实际检查项目，报告保存到 `artifacts/automation-flutter-smoke-report.json`。四类设备逐项结果见 [移动交互验收表](mobile-automation-validation.md)。Android 与 iOS 的模拟器和真机分别验收；无设备、签名或权限准备的项目必须标为未验收。

不包含动作录制回放、完整设备管理、中文输入法候选专项、WebView DOM 自动化、发布安装新版。WebView 可通过可访问节点或显式坐标操作；无法暴露的节点及操作系统限制不能绕过。
