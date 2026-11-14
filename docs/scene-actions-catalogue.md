# Scene 操作归档目录

可复制的操作模板统一维护在 [example.scenes.json](../resources/example.scenes.json)，MCP 的 `workflow` 指南引用同一份文件。项目实际执行只读取自己的 `.flutter-pilot/scenes.json`；复制需要的 Scene 后修改并核验 Key、补齐相应 Mock、重载配置。目录只索引操作，不另存步骤或创建 `workflows.json`。

模板中的 Key 必须在目标 App 源码及当前控件树中核验。邮箱操作采用本轮 Wali 已验证的 Key 模式，其他 App 不能直接照搬；模板通过生产 schema 和编译检查，不等于已在任意 App 完成设备验收。

## 模板目录

| Scene / action                                     | 起点                                 | 参数                                | 终点与用途                                                            |
| -------------------------------------------------- | ------------------------------------ | ----------------------------------- | --------------------------------------------------------------------- |
| `common_operations / login`                        | 通用账号密码登录页                   | `username`、`password`（秘密）      | 等待账号标识与输入用户名一致                                          |
| `common_operations / submit_order`                 | 下单页                               | `price`、`quantity`，均为字符串     | 核对确认页价格、数量后仅提交一次                                      |
| `common_operations / login_and_submit_order`       | 通用账号密码登录页                   | 上述参数，`quantity` 默认 `2`       | 顺序复用登录和下单；须准备业务环境                                    |
| `email_entrypoints / email_login_to_home`          | 显示 Other options 的首次登录页      | `email`、`code`（秘密），均显式传入 | 选择邮箱入口，跨 Scene 调用公共登录步骤并等待主页                     |
| `email_entrypoints / switch_account_login_to_home` | 显示 Switch account 的最近账号登录页 | 同上                                | 切换账号、选择邮箱，再调用同一公共步骤                                |
| `email_operations / complete_email_login_to_home`  | 邮箱输入页已打开                     | 同上                                | 输入邮箱、稳定收起键盘、发送验证码、输入验证码、等待 App shell 和主页 |
| `email_operations / open_home`                     | 已登录 App，底栏可操作               | 无                                  | 点击 Home Key 并等待主页；可在不同 Mock 环境复用                      |

首次登录和最近账号入口具有不同前提。优先根据已知页面选择入口，未知起点时检查一次 UI；不在失败后自动更换入口重跑。邮箱核心和 Home 导航位于纯操作 Scene，所有 `call` 均显式映射参数；调用它们不会激活该 Scene 或切换已有 Mock。

## 已验证的 Wali 实例

调试项目的 `.flutter-pilot/scenes.json` 保存业务环境 `wali-wallet-logged-in` 与公共操作 `wali_common_operations`：

| 业务入口                       | 复用的公共操作                 | 展开步骤 | 设备证据                                     |
| ------------------------------ | ------------------------------ | -------- | -------------------------------------------- |
| `email_login_to_home`          | `complete_email_login_to_home` | 15       | 已预检与原步骤等价；首次入口未独立设备复跑   |
| `switch_account_login_to_home` | `complete_email_login_to_home` | 15       | iPhone 17 模拟器已完成登录并独立确认主页可见 |
| `open_home`                    | `open_home`                    | 4        | 工作台从钱包页手动运行完成，保留当前 Mock    |

Wali 的 40 条 HTTP 规则与操作保存在同一文件，登录后的资产初始化也须核对本轮命中。地址恢复 probe 有意模拟 503 退避，完整地址恢复与单独 NFT 刷新不属于登录验收；不能把后台退避描述成恢复成功。实际运行证据和模板校验分开记录，详见 [验收记录](validation.md) 与调试项目的 `.harness/memory/flutter-pilot-wallet-login-scene.md`。

## 后续归档要求

- 复用前先 `list_scenes`、`list_scene_actions`；动作说明包含起点、身份或页面前提、输入和终点。只在缺少已验证操作时探索和新增。
- `targets` 保存稳定真实 Key，公共步骤归操作所属 Scene。`target` 是别名；执行器自动解析并匹配当前挂载控件，Agent 无需为每一步再截图或 `find_widget`。
- 秘密参数标记 `secret:true`，不保存真实账号、token、会话 ID、设备 UUID 或快照 ref。示例邮箱和验证码由调用者显式传入。
- 输入后键盘可能影响按钮时，使用 `hide_keyboard`，再等按钮 `actionable`。不把固定延时当作页面就绪，也不缓存跨页面 Widget 对象。
- 修改后用生产 schema 和编译器检查各入口与子调用；实际运行记录终态、最终 UI 和本轮新网络证据，说明 Mock 503、未覆盖接口与首请求窗口。
- 步骤调整后更新同一配置和目录的前提、参数、验证状态；不复制第二份运行配置。运行器仍只执行已加载快照，需 `reload_rules` 更新，激活或重连不重放 UI。
