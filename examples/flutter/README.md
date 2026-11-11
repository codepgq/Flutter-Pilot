# Flutter Pilot 示例

这是包含 Android/iOS 宿主的 Dio 5 示例，可发送 GET 和 JSON POST，并展示正常及错误响应。建议使用 Flutter 3.24 或更新版本。

1. 在 VS Code 或 Cursor 中打开当前 `examples/flutter` 目录。
2. 执行 `flutter pub get`，在 IDE 中打开 **Flutter Pilot: 打开工作台**。
3. 启动代理，选择设备连接方式，检查 HTTP 和 HTTPS 诊断。
4. 若设备系统代理无法覆盖 Dio，在接入向导中选择 `lib/main.dart` 中的 `dio`，预览并应用补丁。向导添加开发 helper 和一次初始化调用，不修改 Release/Profile 的客户端行为。
5. 使用工作台显示的代理地址启动，例如 Android USB 已配置 `adb reverse` 时：

   ```sh
   flutter run --dart-define=FLUTTER_PILOT_PROXY=127.0.0.1:8080
   ```

   端口以工作台实际显示为准。iOS 真机使用开发电脑的局域网 IP，并开启插件局域网监听；手机与电脑需要互通。iOS 模拟器通常可使用 `127.0.0.1`。

6. 发送请求，在工作台从历史生成 mock、修改或转发规则；也可为请求或响应设置断点。示例接收超时为 90 秒，默认断点为 60 秒。

默认地址是 `https://httpbin.org/anything`，也可换为本地测试服务。仅完成系统代理设置不代表 Dart 请求必然走代理，以实际诊断结果为准。向导 helper 通过保留系统信任根并加入当前调试 CA 实现 HTTPS，不会关闭证书校验。

Android 本地 HTTP 测试已在 debug manifest 中允许明文流量；iOS 示例声明了本地网络用途。HTTPS 为推荐验证路径。证书固定或自定义适配器需要人工合并，向导不会覆盖已有客户端工厂或证书校验逻辑。

示例不提交任何真实 CA 或 CA 私钥。向导生成的 helper 只包含当前开发 CA 公钥证书。接入向导可撤销自己的补丁；若应用后又编辑了相关文件，向导会保留整组文件，避免破坏用户改动。

停止代理前可先去掉 `--dart-define` 并重新启动应用。应用已创建的 HttpClient 不会因为 IDE 停止代理自动恢复直连。iOS 真机运行时需自行选择 Apple 开发团队，仓库不包含个人签名信息。

```sh
flutter analyze
flutter test
```

单元环境的 Widget 测试验证 POST 参数、正常与错误响应展示和无效 JSON。它们不替代真机和模拟器上的代理、证书与 HTTPS 验收。

仓库开发者可运行设备级 smoke（先在仓库根目录执行 `npm install`）。它使用真实 addon 和接入补丁，自动验证 HTTP/HTTPS mock、转发、双向修改、凭证剥离与真实上游 HTTPS；结束时撤销补丁，不安装系统 CA：

```sh
python3 tool/device_smoke.py --mitmdump /absolute/path/to/mitmdump --ios BOOTED_SIMULATOR_UDID --android AUTHORIZED_ANDROID_SERIAL
```

`--ios`、`--android` 可以只选一个。请确保示例尚未接入且相关源码未修改；脚本不会覆盖已有 `lib/proxy_smoke.dart`。日志保存在示例 `.dart_tool/flutter-pilot-device-smoke-*` 中。已有实机验收结果见 `tool/device-validation.json`，其中明确列出未验证平台。
