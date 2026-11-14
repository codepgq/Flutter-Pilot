import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('executes editing and keyed gesture regressions against the actual Dart runtime template', async (context) => {
  const flutter = process.env.FLUTTER ?? 'flutter';
  const available = spawnSync(flutter, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if ((available.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    context.skip('Flutter SDK is required for headless Dart runtime tests');
    return;
  }
  expect(available.error, available.stderr).toBeUndefined();
  expect(available.status, available.stderr).toBe(0);

  const root = await mkdtemp(join(tmpdir(), 'pilot-unicode-test-'));
  try {
    const source = await readFile(resolve('resources/vm/ui.dart.txt'), 'utf8');
    const helper = source.match(
      /\/\/ BEGIN_UNICODE_EDIT_RANGE\s*([\s\S]*?)\s*\/\/ END_UNICODE_EDIT_RANGE/,
    )?.[1];
    expect(helper, 'the tested helper must come from the production resource').toBeTruthy();
    const screenshot = await readFile(resolve('resources/vm/screenshot.dart.txt'), 'utf8');
    const runtime = source
      .replace('__SCREENSHOT__', screenshot)
      .replaceAll('__SESSION__', "'unicode-test'")
      .replaceAll('__REF_SESSION__', "'unicode-test:0'")
      .replace('__LOCATION__', '((dynamic element) => null)');
    await mkdir(join(root, 'lib'));
    await mkdir(join(root, 'test'));
    await writeFile(
      join(root, 'pubspec.yaml'),
      `name: flutter_pilot_unicode_regression
environment:
  sdk: '>=3.0.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
`,
    );
    await writeFile(
      join(root, 'lib/runtime.dart'),
      `import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:characters/characters.dart' show CharacterRange, StringCharacters;
// Match the widget names available in editable_text.dart's VM evaluation
// scope. In particular, gesture_detector.dart is not imported there.
import 'package:flutter/src/widgets/basic.dart';
import 'package:flutter/src/widgets/binding.dart';
import 'package:flutter/src/widgets/editable_text.dart';
import 'package:flutter/src/widgets/framework.dart';
import 'package:flutter/src/widgets/scrollable.dart';
import 'package:flutter/src/widgets/text.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
${helper}
Map<String, dynamic> createUi(void Function(String, Map<String, dynamic>) emitEvent) {
  final decodeArgs = jsonDecode;
  final encodeBytes = base64Encode;
  return ${runtime};
}
`,
    );
    await writeFile(
      join(root, 'test/unicode_editing_test.dart'),
      await readFile(resolve('tests/fixtures/vm_ui_unicode/test/unicode_editing_test.dart'), 'utf8'),
    );
    await writeFile(
      join(root, 'test/keyed_gestures_test.dart'),
      await readFile(resolve('tests/fixtures/vm_ui_unicode/test/keyed_gestures_test.dart'), 'utf8'),
    );
    for (const args of [
      ['pub', 'get', '--offline'],
      ['test', '--no-pub', '--reporter=expanded'],
    ]) {
      const result = spawnSync(flutter, args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.error, result.stderr || result.stdout).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
