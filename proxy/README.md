# 本地代理引擎

`addon.py` 由扩展随 mitmdump 启动。规则逻辑位于 `rules.py`，请求历史与独立 API 目录保存于工作区私有目录的 `history.sqlite3`。除 mitmproxy 外不要求安装 Python 依赖；官方 macOS 独立包缺少 Python `sqlite3` 时，自动使用系统 `/usr/bin/sqlite3`，通过标准输入传入转义后的 SQL，不调用 shell。

## 控制协议

管理服务由扩展监听 `127.0.0.1`，addon 主动连接并发送带令牌的 `hello`。通信为 UTF-8 JSONL，`protocolVersion` 为 `1`。

请求：`{"id":"...","method":"health","params":{}}`。

响应：`{"id":"...","result":{...}}`，失败响应为 `{"id":"...","error":{"message":"..."}}`。

支持 `health`、`proxy.start`、`proxy.stop`、`rules.sync`、`history.list`、`history.get`、`history.apis`、`history.update`、`history.delete`、`history.clear`、`api.delete`、`api.clear`、`breakpoint.setInteractive`、`breakpoint.resolve` 和 `breakpoint.releaseAll`。

`history.list` 返回分页摘要，包含 `status`，不包含正文快照；`history.get` 返回原始、自动规则处理后、人工修改后三份请求/响应快照。`history.apis` 从独立 `api_catalog` 读取，按方法、主机、路径去重，返回 `{items:[{method,host,path,count,firstAt,lastAt}]}`；`count` 为目录保留期间累计发现的调用次数。请求历史清空、删除、过期或数量裁剪不删除目录。旧库首次打开时从现存历史迁移一次，迁移标记避免手动删除的目录在下次启动时由旧历史重新生成。`history.list` 支持同名精确筛选。

`api.delete` 参数为 `{method,host,path}`，仅删除对应 API 目录项，返回 `{deleted}`；`api.clear` 清空目录但保留请求历史。新的请求再次命中已删除的 API 时，会重新发现并从 1 计数。API 目录与历史共享 SQLite 文件，但拥有独立生命周期。

`proxy.stop` 关闭流量监听并释放断点，保留控制通道和数据库访问。关闭工作台不终止后台记录；扩展退出或工作区被移除才终止对应引擎进程。引擎监听暂定端口由启动参数提供；`health.proxyPort` 返回实际端口。首次安装可以使用 `--set server=false` 启动，按用户操作再调用 `proxy.start`。

`breakpoint.setInteractive` 参数为 `{enabled:boolean}`，返回 `{enabled,released}`。默认 `false`，后台抓取不创建人工断点；工作台打开时设为 `true`，关闭时设为 `false` 并释放正在等待的断点。自动规则、Mock 与请求记录继续执行。`health.interactive` 可查询当前模式；控制断连也会关闭交互模式，重新连接后由扩展显式恢复。

事件包括 `ready`、`status`、`history`、`api.updated`、`breakpoint` 和 `breakpoint.resolved`。时间均为 Unix 毫秒。控制连接断开会释放当前断点并自动重连；断开期间不会创建新的断点。

## 正文限制

- JSON、文本和表单文本在保存上限内可以修改。
- 上传、二进制、SSE、chunked 及无明确长度的流式内容直通，仅保留有界前缀。
- gzip/deflate 使用限定输出长度的解码器；解压超过上限时保持原始网络内容，快照标记截断，`bodyBytes` 为已知下界。
- br/zstd 以及无法安全解码的压缩格式保持直通，快照展示编码限制。
- 原始正文、HTTP 方法和头部不因记录截断而发生修改。
- 控制帧上限为 `max(64 MiB, maxBodyBytes * 10 + 1 MiB)`；极端转义体积超过上限时返回明确错误，不中断控制连接。

## 验证

```sh
python3 -m unittest discover -s tests/proxy -p 'test_*.py' -v
API_MOCK_SQLITE_CLI=1 python3 -m unittest discover -s tests/proxy -p 'test_storage.py' -v
MITMDUMP=/绝对路径/mitmdump python3 -m unittest discover -s tests/proxy -p 'test_*.py' -v
```

未设置 `MITMDUMP` 时真实代理集成测试标记为跳过；不能将该次运行计为 HTTP/HTTPS 已验证。集成测试使用本地 HTTP/HTTPS 服务、独立测试证书、真实 CA 信任及认证控制通道，不关闭上游 TLS 校验。
