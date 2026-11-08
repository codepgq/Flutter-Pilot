# 第三方说明

## mitmproxy

- 项目：https://github.com/mitmproxy/mitmproxy
- 版本：12.3.1
- 许可：MIT，https://github.com/mitmproxy/mitmproxy/blob/v12.3.1/LICENSE
- 插件不内嵌引擎；首次使用从官方 https://downloads.mitmproxy.org/ 下载独立包并校验固定 SHA-256。完整应用包及其许可证、第三方声明保存在插件私有引擎目录。
- macOS standalone 未带 Python sqlite3 模块时，使用系统 /usr/bin/sqlite3 作为 SQLite 后备。

## React / React DOM

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

完整 npm 依赖锁定在 package-lock.json。构建时 esbuild 保留上游法律注释；开发和测试依赖不打包进 VSIX。
