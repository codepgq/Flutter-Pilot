import 'dart:typed_data';

import 'package:flutter_pilot_example/main.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _TestAdapter implements HttpClientAdapter {
  _TestAdapter({this.status = 201});

  final int status;
  RequestOptions? request;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    request = options;
    return ResponseBody.fromString(
      '{"mocked":true}',
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  testWidgets('发送 POST 并展示 Dio 返回的数据', (tester) async {
    final adapter = _TestAdapter();
    final dio = Dio()..httpClientAdapter = adapter;
    await tester.pumpWidget(FlutterPilotExample(dio: dio));
    await tester.tap(find.text('POST'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('request-body')),
      '{"message":"测试"}',
    );
    await tester.tap(find.byKey(const Key('send-request')));
    await tester.pumpAndSettle();
    expect(adapter.request?.method, 'POST');
    expect(adapter.request?.data, {'message': '测试'});
    expect(find.textContaining('HTTP 201'), findsOneWidget);
    expect(find.textContaining('"mocked": true'), findsOneWidget);
    dio.close();
  });

  testWidgets('服务端错误状态仍展示响应正文', (tester) async {
    final dio = Dio()..httpClientAdapter = _TestAdapter(status: 503);
    await tester.pumpWidget(FlutterPilotExample(dio: dio));
    await tester.tap(find.byKey(const Key('send-request')));
    await tester.pumpAndSettle();
    expect(find.textContaining('HTTP 503'), findsOneWidget);
    expect(find.textContaining('"mocked": true'), findsOneWidget);
    dio.close();
  });

  testWidgets('无效 JSON 不发送请求，并显示可修正的错误', (tester) async {
    final adapter = _TestAdapter();
    final dio = Dio()..httpClientAdapter = adapter;
    await tester.pumpWidget(FlutterPilotExample(dio: dio));
    await tester.tap(find.text('POST'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('request-body')), '{invalid');
    await tester.tap(find.byKey(const Key('send-request')));
    await tester.pumpAndSettle();
    expect(adapter.request, isNull);
    expect(find.textContaining('FormatException'), findsOneWidget);
    dio.close();
  });
}
