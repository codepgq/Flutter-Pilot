/// Exercises keyed hit testing against the production injected runtime.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_pilot_unicode_regression/runtime.dart';

void main() {
  for (final callback in ['down', 'up']) {
    testWidgets('keyed siblings preserve their coordinates for onTap$callback', (
      tester,
    ) async {
      final positions = <Offset>[];
      final fixture = GestureFixture(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              excludeFromSemantics: true,
              onTapDown: callback == 'down'
                  ? (details) => positions.add(details.globalPosition)
                  : null,
              onTapUp: callback == 'up'
                  ? (details) => positions.add(details.globalPosition)
                  : null,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final key in ['left', 'right'])
                    Semantics(
                      button: true,
                      onTap: () {},
                      child: SizedBox(
                        key: ValueKey(key),
                        width: 80,
                        height: 60,
                        child: const ColoredBox(color: Colors.blue),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
      for (final key in ['left', 'right']) {
        final info = await fixture.describe(key);
        expect(info['actionable'], isTrue);
        expect(await fixture.invoke('tap', key: key), containsPair('ok', true));
        // Automation resolves this same keyed region and sends pointer tracks.
        expect(await fixture.gestureAt(info), containsPair('ok', true));
      }
      final left = tester.getCenter(find.byKey(const ValueKey('left')));
      final right = tester.getCenter(find.byKey(const ValueKey('right')));
      expect(positions, [left, left, right, right]);
      await fixture.dispose();
    });
  }

  testWidgets('semantic owner identifies a tab without invoking its callback', (
    tester,
  ) async {
    var semanticCalls = 0;
    final pointerPositions = <Offset>[];
    final fixture = GestureFixture(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: GestureDetector(
            // This is a private gesture epoch, as used by GlassTabBar.
            key: const ValueKey(0),
            excludeFromSemantics: true,
            onTapDown: (details) =>
                pointerPositions.add(details.globalPosition),
            child: Semantics(
              button: true,
              onTap: () => semanticCalls++,
              child: const SizedBox(
                key: ValueKey('tab'),
                width: 80,
                height: 60,
                child: ColoredBox(color: Colors.blue),
              ),
            ),
          ),
        ),
      ),
    );
    expect((await fixture.describe('tab'))['actionable'], isTrue);
    expect(await fixture.invoke('tap', key: 'tab'), containsPair('ok', true));
    expect(pointerPositions, [
      tester.getCenter(find.byKey(const ValueKey('tab'))),
    ]);
    expect(semanticCalls, 0);
    await fixture.dispose();
  });

  testWidgets('disabled button cannot be activated through a keyed label', (
    tester,
  ) async {
    final fixture = GestureFixture(tester);
    await tester.pumpWidget(
      const MaterialApp(
        home: Center(
          child: TextButton(
            onPressed: null,
            child: Text('Disabled', key: ValueKey('disabledLabel')),
          ),
        ),
      ),
    );
    final info = await fixture.describe('disabledLabel');
    expect(info['enabled'], isFalse);
    expect(info['actionable'], isFalse);
    expect(
      await fixture.invoke('tap', key: 'disabledLabel'),
      containsPair('code', 'NOT_ENABLED'),
    );
    await fixture.dispose();
  });

  testWidgets(
    'enabled InkWell accepts a keyed label through its pointer owner',
    (tester) async {
      var taps = 0;
      final fixture = GestureFixture(tester);
      await tester.pumpWidget(
        MaterialApp(
          home: Material(
            child: Center(
              child: InkWell(
                onTap: () => taps++,
                child: const SizedBox(
                  key: ValueKey('inkLabel'),
                  width: 80,
                  height: 60,
                  child: Text('Enabled'),
                ),
              ),
            ),
          ),
        ),
      );
      expect((await fixture.describe('inkLabel'))['actionable'], isTrue);
      expect(
        await fixture.invoke('tap', key: 'inkLabel'),
        containsPair('ok', true),
      );
      expect(taps, 1);
      await fixture.dispose();
    },
  );

  for (final blocked in ['overlay', 'ignore']) {
    testWidgets('$blocked still blocks an otherwise actionable keyed child', (
      tester,
    ) async {
      var taps = 0;
      final fixture = GestureFixture(tester);
      final target = GestureDetector(
        onTap: () => taps++,
        excludeFromSemantics: true,
        child: Semantics(
          button: true,
          onTap: () {},
          child: IgnorePointer(
            ignoring: blocked == 'ignore',
            child: const ColoredBox(
              key: ValueKey('blocked'),
              color: Colors.blue,
              child: SizedBox(width: 80, height: 60),
            ),
          ),
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Center(
            child: Stack(
              children: [
                target,
                if (blocked == 'overlay')
                  const Positioned.fill(
                    child: AbsorbPointer(child: ColoredBox(color: Colors.red)),
                  ),
              ],
            ),
          ),
        ),
      );
      final info = await fixture.describe('blocked');
      expect(info['visible'], isFalse);
      expect(info['actionable'], isFalse);
      expect(
        await fixture.invoke('tap', key: 'blocked'),
        containsPair('code', 'NOT_HIT_TESTABLE'),
      );
      expect(taps, 0);
      await fixture.dispose();
    });
  }

  for (final boundary in ['gesture', 'wrapper']) {
    testWidgets('page dismissal does not own content with a $boundary key', (
      tester,
    ) async {
      var dismissals = 0;
      final fixture = GestureFixture(tester);
      final gesture = GestureDetector(
        key: boundary == 'gesture' ? const ValueKey('page.root') : null,
        behavior: HitTestBehavior.opaque,
        onTap: () => dismissals++,
        child: const Center(child: Text('Content', key: ValueKey('content'))),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: boundary == 'wrapper'
              ? SizedBox(key: const ValueKey('page.root'), child: gesture)
              : gesture,
        ),
      );
      expect((await fixture.describe('content'))['actionable'], isFalse);
      expect(
        await fixture.invoke('tap', key: 'content'),
        containsPair('code', 'AMBIGUOUS_ACTION_TARGET'),
      );
      expect(dismissals, 0);
      await fixture.dispose();
    });
  }

  testWidgets('a semantic callback alone does not advertise physical input', (
    tester,
  ) async {
    var semanticCalls = 0;
    final fixture = GestureFixture(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: Semantics(
            button: true,
            onTap: () => semanticCalls++,
            child: const ColoredBox(
              key: ValueKey('semanticOnly'),
              color: Colors.blue,
              child: SizedBox(width: 80, height: 60),
            ),
          ),
        ),
      ),
    );
    expect((await fixture.describe('semanticOnly'))['actionable'], isFalse);
    expect(
      await fixture.invoke('tap', key: 'semanticOnly'),
      containsPair('code', 'AMBIGUOUS_ACTION_TARGET'),
    );
    expect(semanticCalls, 0);
    await fixture.dispose();
  });

  testWidgets('an ordinary page tap cannot own a semantics-only button', (
    tester,
  ) async {
    var dismissals = 0;
    var semanticCalls = 0;
    final fixture = GestureFixture(tester);
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          key: const ValueKey('page.root'),
          child: GestureDetector(
            onTap: () => dismissals++,
            child: Semantics(
              button: true,
              onTap: () => semanticCalls++,
              child: const ColoredBox(
                key: ValueKey('semanticButton'),
                color: Colors.blue,
                child: SizedBox(width: 80, height: 60),
              ),
            ),
          ),
        ),
      ),
    );
    expect((await fixture.describe('semanticButton'))['actionable'], isFalse);
    expect(
      await fixture.invoke('tap', key: 'semanticButton'),
      containsPair('code', 'AMBIGUOUS_ACTION_TARGET'),
    );
    expect([dismissals, semanticCalls], [0, 0]);
    await fixture.dispose();
  });
}

class GestureFixture {
  GestureFixture(this.tester);
  final WidgetTester tester;
  final results = <String, Map<String, dynamic>>{};
  var sequence = 0;
  late final runtime = createUi((kind, event) {
    results[event['operationId'] as String] =
        event['result'] as Map<String, dynamic>;
  });

  Future<Map<String, dynamic>> describe(String key) async {
    final result = await invoke('find_widget', key: key);
    expect(result['ok'], isTrue, reason: '$result');
    return result['widget'] as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> gestureAt(Map<String, dynamic> info) {
    final bounds = info['bounds'] as Map<String, dynamic>;
    return invoke(
      'perform_gesture',
      args: {
        'tracks': [
          {
            'actions': [
              {
                'type': 'pointerMove',
                'duration': 0,
                'x': bounds['x'] + bounds['width'] / 2,
                'y': bounds['y'] + bounds['height'] / 2,
              },
              {'type': 'pointerDown', 'button': 0},
              {'type': 'pause', 'duration': 40},
              {'type': 'pointerUp', 'button': 0},
            ],
          },
        ],
      },
    );
  }

  Future<Map<String, dynamic>> invoke(
    String tool, {
    String? key,
    Map<String, dynamic> args = const {},
  }) async {
    final id = '${++sequence}';
    runtime['launch'](
      id,
      tool,
      jsonEncode({
        if (key != null) 'key': {'type': 'string', 'value': key},
        ...args,
      }),
    );
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (results.containsKey(id)) return results.remove(id)!;
    }
    throw StateError('The injected gesture did not complete');
  }

  Future<void> dispose() async {
    runtime['active'] = false;
    await tester.pumpWidget(const SizedBox.shrink());
  }
}
