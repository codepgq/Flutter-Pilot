# Scene 目录存储 v2

Mock、targets 与 actions 的持久来源是 `.flutter-pilot/scenes/`。旧 `scenes.json` 只由显式迁移工具读取；运行器不回退到旧文件。`tests.json` 保持独立 v2。

```text
.flutter-pilot/
  scenes/
    index.json
    <scene-directory>/
      scene.json
      targets.json
      http/<rule-file>.json
      ws/<rule-file>.json
      actions/<action-file>.json
      bodies/<body-file>.txt
  tests.json
```

根清单 `{ "version":2, "scenes":[{"id":"orders","directory":"uuid-directory"}] }` 的数组顺序就是展示顺序。Scene 清单 `{ "id":"orders", "name":"订单", "http":[{"id":"empty","file":"uuid.json"}], "ws":[], "actions":[] }` 只记录资源 ID、文件映射与顺序。`targets.json` 保存选择器字典。文件名不参与业务引用，新建文件默认 UUID；改名、移动文件需同时更新映射，保持业务 ID。`call.sceneId/actionId` 和 Test Case v2 引用不变。

每条 HTTP、WS 规则和每个 action 各一个 JSON 文件，使用既有规则与动作字段。HTTP `request/response/mock.bodyFile` 与 `body` 互斥；WS `action.textFile` 与 `text` 互斥。例如 `"bodyFile":"bodies/response.txt"`。文件保存原始 UTF-8 字节；空正文允许内联 `"body":""`，人工也可内联短文本。插件默认把非空正文外置。引用只能是所属 Scene 的 `bodies/<普通文件名>`，拒绝绝对路径、越界、嵌套路径和符号链接。规则与资源文件也禁止符号链接。

可复制的目录示例见 [example-scenes/index.json](../resources/example-scenes/index.json)。[example.scenes.json](../resources/example.scenes.json) 是正文内联的 v2 交换包，用于导入，不是运行配置文件。导出选定 Scene 会递归包含包外操作依赖；追加导入重建 Scene 与规则 ID，并重写组内跨 Scene 引用，保持 action ID 与当前激活状态。

## 发现、编辑与执行

`get_network_status.files.scenes` 返回根清单绝对路径，`storageVersion` 为 2。`list_scenes` 接受 `offset`、`limit`、`search`，默认 50 条、最多 200 条；搜索 Scene ID、名称和规则、动作名称。返回准确目录、清单路径、数量、健康状态及当前 Mock。`list_scene_actions` 返回指定 Scene 的 targets、操作概要、参数、文件路径和阻塞原因，不读取 Mock 正文。

打开 Scene 读取规则及动作概要；编辑规则和预览操作时才请求对应资源。详情响应携带请求序号和版本，旧响应不能覆盖快速切换后的选择。普通网络和运行进度消息不携带场景定义或持久规则正文；命中名称按当前历史 ID 查询轻量索引。

激活仅装配该 Scene 的 HTTP/WS 规则及正文。运行动作只读取根操作、递归 call 依赖与所属 targets。测试在执行前为 setup、主动作及 Mock 准备同一不可变快照；执行期间磁盘编辑不改变本轮。VM 和 Python 代理仍收到内联字符串，不解析文件引用。激活、reload、重连和 IDE 恢复不执行 UI。

激活 ID 和派生摘要缓存保存在按工作区隔离的 IDE 项目私有目录。切换场景不改 Git 文件；重开 IDE 恢复选择。缓存可删除重建，冷建索引跳过正文文件，摘要缓存按 Scene 分片，后续按资源文件签名刷新；单项保存只更新所属 Scene 摘要及缓存。Agent 编辑后调用 `reload_rules`。

## 冲突、事务与错误

保存携带读取时的内容指纹，规则指纹同时涵盖关联正文。外部修改后必须重读，不能用旧编辑器覆盖。项目级跨进程写锁串行化插件写入；多文件写入先落临时文件和事务日志，再原子替换各文件，启动时继续完成未完成事务。恢复先核对所有文件的 before/after 指纹；发现人工修改则保留日志、临时文件和现有文件并报告冲突。

损坏 Scene 显示错误并拒绝新激活和运行；依赖它的操作标记阻塞，其他有效 Scene 可用。重复规则 ID 标记同协议所有冲突 Scene。缺失动作、循环、参数与目标错误在执行前拒绝；缺正文、非法 UTF-8 在读取正文时拒绝。当前配置损坏时保留最后有效运行快照，`runtime.stale` 说明新配置未生效。根清单损坏保留上版目录快照并阻止新执行；重开 IDE 可从私有目录摘要恢复上次列表，缓存不参与执行。

恢复会在整批预检和每项替换前复查目标与临时文件；坏日志、越界路径和超限写入在修改源文件前拒绝，回收写锁的进程再次退出也可恢复。项目锁串行化遵守锁协议的插件进程；外部编辑器不遵守该锁，文件系统无法把指纹检查与 rename 合成原子比较替换，仍存在两者之间的竞争窗口。

损坏的私有激活记录保留诊断并回退未激活；缓存分片携带完整性摘要，损坏时重建。无法解析清单的 Scene 被隔离，其他健康 Scene 仍可新增规则；修复后重新读取时统一检查全局 ID。导出在同一项目锁内读取并复查资源，保留无 action 的 Scene targets。

删除 Scene 从根清单移除，原目录保留供恢复；更新正文写入新的 UUID 文件，旧正文保留，避免误删人工复用文件。未引用文件不参与运行，可在确认引用后通过 Git 清理。

移除全库 1000 Scene / 5000 步骤限制。单资源上限 16 MiB，单操作最多 500 步、嵌套最多 16 层、单次快照最多 1000 个操作资源、展开最多 1000 原子动作。HTTP/WS 接入自身的执行限额继续适用；这些限额不限制整个场景库的正文总量。

## 迁移

安装后的 IDE 可直接运行命令 **Flutter Pilot: 迁移 Scene v1 到 v2**，先展示预检数量和正文字节数，再选择仅预检或正式转换；无需成功打开旧格式工作台。

也可在本仓库执行，参数是业务项目 `.flutter-pilot` 的绝对路径：

```sh
npm run scenes:migrate -- /path/to/project/.flutter-pilot --check
npm run scenes:migrate -- /path/to/project/.flutter-pilot --apply
```

预检用生产 v1 校验器读取旧文件，在临时目录拆分，再校验装配数据、UTF-8 正文和动作展开；正式转换再次执行相同校验，确认源文件未变后发布新目录。拒绝覆盖已有 `scenes/`，保留旧文件。迁移报告记录旧激活 ID，新工作区初始不激活，由用户首次选择。缺新结构但存在旧文件时提示迁移，不自动创建空配置。

验收分为仓库/协议、合成工作台和实际设备；0.0.22 已按用户授权打包并安装到 Cursor，发布检查不包含业务设备验收。规模数据与实际耗时记录在 `artifacts/scene-storage-scale.json`。
