# 项目 UUID、配置与规则文件

插件以 Cursor / VS Code 打开的工作区文件夹为项目根。首次初始化时创建 `.api-mocks/`，生成并保存一个 UUID；重新打开项目时读取已有 UUID。多根工作区分别绑定所选文件夹，Dart workspace 则沿用 IDE 打开的根目录。

项目身份不再只由路径决定。项目的配置和规则可以随文件夹保留，而本机请求历史仍按实际目录隔离，避免多个副本或 worktree 混用数据。

## 文件分工

```text
项目根目录/
└── .api-mocks/
    ├── project.json    # 格式版本、项目 UUID、显示名称、接入配置与项目设置
    └── rules.json      # 当前目录使用的 Mock 规则
```

请求历史、API 目录、CA 私钥和设备相关的本机连接记录不写入这两个文件。Flutter VM WS 仅在当前会话内使用，不写入项目或本机配置。

是否将 `.api-mocks/` 纳入 Git 由项目自行决定。插件创建和更新文件，但不会自动暂存、提交或推送。若纳入版本控制，同事或其他 IDE 可以读取同一份配置和规则；各自的请求历史与 CA 仍保持独立。

## project.json

示例：

```json
{
  "version": 1,
  "projectId": "edb038d8-0a2a-4b1f-a974-d39e1a5af278",
  "name": "commerce_app",
  "connection": {
    "mode": "vm"
  },
  "settings": {
    "retentionDays": 7,
    "maxRecords": 10000,
    "maxBodyBytes": 1048576,
    "breakpointTimeout": 60,
    "autoStart": true,
    "autoConnectVm": true
  }
}
```

新项目由插件生成自己的 `projectId`，不要将上例 UUID 当作所有项目的固定值。

| 字段 | 含义 |
| --- | --- |
| `version` | 文件格式版本，当前为 `1` |
| `projectId` | 项目的 UUID，后续读取和保存时复用 |
| `name` | 项目显示名称，初次使用文件夹名称 |
| `connection.mode` | `vm` 或 `proxy`，新项目默认 `vm` |
| `connection.lan` | 代理是否允许局域网连接；VM 路线不需要此项 |
| `connection.connectionHost` | 已选择的代理连接地址，不是 VM WS 地址 |
| `connection.port` | 已选择或分配的代理端口 |
| `connection.configuredPort` | 与已保存端口对应的配置值，用于判断端口偏好是否仍适用 |
| `settings` | 可选的项目设置；没有指定的值使用 IDE 工作区 / 用户设置 |

项目 `settings` 使用不带 `flutterApiMocks.` 前缀的字段名：

| 字段 | 默认值 | 范围与说明 |
| --- | --- | --- |
| `retentionDays` | `7` | 1–365 天 |
| `maxRecords` | `10000` | 1–100000 条请求历史 |
| `maxBodyBytes` | `1048576` | 1024–10485760 字节；VM 注入正文另有 256 KiB 上限 |
| `breakpointTimeout` | `60` | 10–300 秒，人工断点仅代理模式支持 |
| `autoStart` | `true` | 已选择代理模式时，自动启动已安装 / 配置引擎 |
| `autoConnectVm` | `true` | VM 模式唯一 Flutter Debug 会话自动连接；读取项目文件后立即应用，关闭时保留已有连接 |

项目设置优先于对应 IDE 设置；未指定字段回退 IDE 设置，再使用插件默认值。引擎可执行文件路径仍由本机 IDE 的 `flutterApiMocks.enginePath` 管理，避免把某台电脑的绝对路径当成项目通用配置。

`autoConnectVm` 是独立设置，项目值覆盖 IDE 值；手动断开会暂停本次调试会话自动重连。认证 VM / DTD 地址始终只在内存，不保存供下次复用。

VM 默认连接后只记录 API，运行时 Dio Mock 需要在工作台主动开启。`autoStart: true` 不会保存认证 WS，也不代表在重新打开 IDE 后自动连接到上一次 App。

## rules.json

规则格式与导入 / 导出一致：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "products-empty",
      "name": "产品列表为空",
      "enabled": false,
      "priority": 0,
      "match": {
        "method": "GET",
        "host": "api.example.test",
        "path": "/api/products"
      },
      "mock": {
        "status": 200,
        "headers": {
          "content-type": "application/json"
        },
        "body": "{\"items\":[]}"
      }
    }
  ]
}
```

工作台中创建、编辑、复制、启停或删除规则会更新当前项目目录的这份文件。规则启用与 VM 运行时 Mock 总开关是两层状态：VM 仅采集时，即使规则已启用也不会改写应用数据。

## 读取与配置修改

连接页的项目绑定卡显示项目名称与 UUID，并提供三个操作：

- **项目配置**：打开 `.api-mocks/project.json`。
- **规则文件**：打开 `.api-mocks/rules.json`。
- **读取项目文件**：重新校验并读取磁盘文件，加载规则并同步到运行中的会话。

打开工作区时读取项目文件。已有配置或规则不是合法 JSON、格式版本不支持或字段值无效时，插件显示配置错误，保留原文件，不重新生成 UUID 或用空规则覆盖。

在外部编辑器修改项目文件后，先保存文件，再点击 **读取项目文件**。如果规则文件已被其他编辑更新，插件会阻止未更新的工作台保存覆盖磁盘内容；重新读取后再继续操作。

规则可以在读取后同步生效。接入方式、端口、容量和保留策略使用会话启动时的配置快照；外部修改后，工作台提示 **重载窗口后生效**，当前活动连接继续运行。仅关闭工作台不会重启后台连接。

如果修改了 `projectId`，当前会话不会立即切换到另一个项目存储；应重新加载窗口，让新身份建立独立会话。如果需要把复制项目视为新的逻辑项目，先结束对应调试会话，再为它建立新 UUID；不同目录即使保留相同 UUID，本机历史也不会混用。

## 复制、worktree 与路径变化

| 操作 | 项目配置和规则 | 本机历史与 API 目录 |
| --- | --- | --- |
| 重新打开同一路径 | 读取原有 UUID 与文件 | 接续同一目录的数据 |
| 同一目录换用 VS Code / Cursor | 两款 IDE 读取同一份项目文件 | 分别保存在各 IDE 私有存储 |
| 复制项目，保留 UUID | 读取副本自己的文件，后续各自编辑 | 按副本路径独立记录 |
| 新建 Git worktree，保留 UUID | 读取该 worktree 的配置与规则 | 按 worktree 路径独立记录 |
| 移动或重命名项目目录 | UUID 与规则可以随文件保留 | 不承诺自动接续旧路径历史 |

UUID 用来表达逻辑项目身份，不用来强制合并多个开发目录的运行数据。每个目录拥有独立 VM / 代理会话和 SQLite，避免一处停止代理、清空历史或修改本机连接影响另一目录。

私有存储结构：

```text
<IDE globalStorage>/api-mocks.flutter-api-mocks/
└── projects/<项目 UUID>/<工作区 URI 哈希前 24 位>/
    ├── history.sqlite3
    ├── vm-history.sqlite3
    ├── connection.json
    └── ca/
```

规则以项目文件为准，不再以私有目录中的旧 `rules.json` 作为日常编辑入口。本机设备记录保持私有，不随项目配置分发。

## 旧版数据迁移

升级后首次绑定当前目录时：

1. 项目文件不存在时，生成 UUID，并将旧版私有 `connection.json` 中可迁移的接入配置写入项目配置。旧连接文件没有 `mode` 时按原代理路线兼容；完全没有旧设置的新项目默认 VM。
2. `.api-mocks/rules.json` 不存在时，校验并导入该目录旧版私有 `rules.json`。项目中已有的规则优先，不用旧数据覆盖。
3. 将该目录旧版 `workspaces/<工作区哈希>/` 下的历史数据库、CA 和本机连接记录按白名单复制到 `projects/<项目 UUID>/<工作区哈希>/`，接续原有请求历史与 API 目录。旧目录保留。
4. 迁移认领标记防止后续更换 UUID 时把同一旧历史再次导入另一个身份。迁移不会删除源数据；已有项目文件错误时先提示修复，不通过重新生成文件掩盖错误。

升级迁移与项目复制的含义不同：迁移读取同一工作区的旧版私有记录；复制到新目录后，不会因为 UUID 相同就把其他目录历史自动导入。

具体实现与验收结论以 [验收记录](validation.md) 为准。项目文件不包含 VM 认证地址或 CA 私钥，示例只使用合成域名与数据。
