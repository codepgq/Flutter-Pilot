import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dio = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 90),
    ),
  );
  // 在 IDE 工作台中预览接入补丁，会在此处添加 await configureApiMocks(dio)。
  runApp(ApiMocksExample(dio: dio));
}

/// 使用真实 Dio 客户端验证请求修改、Mock、转发和响应断点。
class ApiMocksExample extends StatelessWidget {
  const ApiMocksExample({required this.dio, super.key});

  final Dio dio;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'API Mocks 示例',
      theme: ThemeData(colorSchemeSeed: const Color(0xff6750a4)),
      darkTheme: ThemeData(
        colorSchemeSeed: const Color(0xff6750a4),
        brightness: Brightness.dark,
      ),
      home: _RequestPage(dio: dio),
    );
  }
}

class _RequestPage extends StatefulWidget {
  const _RequestPage({required this.dio});

  final Dio dio;

  @override
  State<_RequestPage> createState() => _RequestPageState();
}

class _RequestPageState extends State<_RequestPage> {
  final _url = TextEditingController(text: 'https://httpbin.org/anything');
  final _body = TextEditingController(text: '{"message":"来自 Flutter 的请求"}');
  String _method = 'GET';
  String _result = '在 IDE 启动代理并完成接入后，点击发送。';
  bool _sending = false;

  @override
  void dispose() {
    _url.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_sending) return;
    setState(() => _sending = true);
    try {
      final url = Uri.tryParse(_url.text.trim());
      if (url == null ||
          !{'http', 'https'}.contains(url.scheme) ||
          url.host.isEmpty) {
        throw const FormatException('请输入完整的 HTTP 或 HTTPS 地址。');
      }
      final Object? body = _method == 'POST' ? jsonDecode(_body.text) : null;
      final response = await widget.dio.request<Object?>(
        url.toString(),
        data: body,
        options: Options(method: _method),
      );
      _showResponse(response);
    } on DioException catch (error) {
      if (error.response != null) {
        _showResponse(error.response!);
      } else if (mounted) {
        setState(() => _result = '网络错误：${error.message}\n请检查代理、证书和设备连接。');
      }
    } catch (error) {
      if (mounted) setState(() => _result = '请求失败：$error');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _showResponse(Response<Object?> response) {
    if (!mounted) return;
    final content = response.data is String
        ? response.data as String
        : const JsonEncoder.withIndent('  ').convert(response.data);
    setState(() {
      _result = 'HTTP ${response.statusCode}\n'
          '${response.requestOptions.method} ${response.requestOptions.uri}\n\n'
          '${response.headers}\n$content';
    });
  }

  @override
  Widget build(BuildContext context) {
    const proxy = String.fromEnvironment('API_MOCK_PROXY');
    return Scaffold(
      appBar: AppBar(title: const Text('Flutter API Mocks')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            proxy.isEmpty
                ? '未指定调试代理。请通过 IDE 接入向导配置。'
                : '调试代理参数：$proxy（需要已应用接入补丁）',
          ),
          const SizedBox(height: 20),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'GET', label: Text('GET')),
              ButtonSegment(value: 'POST', label: Text('POST')),
            ],
            selected: {_method},
            onSelectionChanged: _sending
                ? null
                : (value) => setState(() => _method = value.single),
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('request-url'),
            controller: _url,
            decoration: const InputDecoration(
              labelText: '接口地址',
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('request-body'),
            controller: _body,
            enabled: _method == 'POST',
            decoration: const InputDecoration(
              labelText: 'JSON 请求体（POST）',
              border: OutlineInputBorder(),
            ),
            minLines: 2,
            maxLines: 6,
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            key: const Key('send-request'),
            onPressed: _sending ? null : _send,
            icon: _sending
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.send),
            label: Text(_sending ? '等待响应（可在 IDE 中处理断点）' : '发送请求'),
          ),
          const SizedBox(height: 20),
          const Text('响应结果'),
          const SizedBox(height: 8),
          SelectableText(_result, key: const Key('response-result')),
        ],
      ),
    );
  }
}
