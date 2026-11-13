import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_pilot_unicode_regression/runtime.dart';

const clusters = ['😀', 'e\u0301', '👩‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '👍🏽'];

void main() {
  group('complete-text grapheme boundaries', () {
    for (final cluster in clusters) {
      test('rejects every internal UTF-16 offset in $cluster', () {
        final text = 'A${cluster}Z';
        for (var offset = 2; offset < 1 + cluster.length; offset++) {
          for (final args in [
            {'action': 'move_cursor', 'offset': offset},
            {'action': 'select_range', 'start': 0, 'end': offset},
            {'action': 'select_range', 'start': offset, 'end': 0},
          ]) {
            expect(
              editTextRange(text, 0, 0, args)['code'],
              'INVALID_TEXT_BOUNDARY',
            );
          }
          for (final action in ['delete', 'copy', 'cut', 'paste']) {
            expect(
              editTextRange(text, offset, offset, {'action': action})['code'],
              'INVALID_TEXT_BOUNDARY',
            );
            expect(
              editTextRange(text, offset, text.length, {
                'action': action,
              })['code'],
              'INVALID_TEXT_BOUNDARY',
            );
          }
        }
      });

      test('deletes a whole $cluster at a legal boundary', () {
        final result = editTextRange(
          'A${cluster}Z',
          1 + cluster.length,
          1 + cluster.length,
          {'action': 'delete'},
        );
        expect(result, {'ok': true, 'text': 'AZ', 'start': 1, 'end': 1});
      });

      test('preserves reverse $cluster selection and deletes it safely', () {
        final text = 'A${cluster}Z';
        final selected = editTextRange(text, 0, 0, {
          'action': 'select_range',
          'start': 1 + cluster.length,
          'end': 1,
        });
        expect(selected['start'], 1 + cluster.length);
        expect(selected['end'], 1);
        expect(
          editTextRange(text, selected['start'], selected['end'], {
            'action': 'delete',
          }),
          {'ok': true, 'text': 'AZ', 'start': 1, 'end': 1},
        );
      });
    }

    test(
      'handles empty text and the initial boundary without deleting ahead',
      () {
        expect(editTextRange('', 0, 0, {'action': 'delete'}), {
          'ok': true,
          'text': '',
          'start': 0,
          'end': 0,
        });
        expect(editTextRange('😀', 0, 0, {'action': 'delete'}), {
          'ok': true,
          'text': '😀',
          'start': 0,
          'end': 0,
        });
      },
    );

    test('rejects out-of-range explicit offsets and existing selections', () {
      for (final offset in [-1, 4]) {
        expect(
          editTextRange('😀', 0, 0, {
            'action': 'move_cursor',
            'offset': offset,
          })['code'],
          'INVALID_ARGUMENT',
        );
        expect(
          editTextRange('😀', 0, 0, {
            'action': 'select_range',
            'start': offset,
            'end': 0,
          })['code'],
          'INVALID_ARGUMENT',
        );
        expect(
          editTextRange('😀', offset, 0, {'action': 'delete'})['code'],
          'INVALID_SELECTION',
        );
      }
    });
  });

  group('actual injected editing operations', () {
    testWidgets('describes the actual editor bounds inside a decorated field', (
      tester,
    ) async {
      final fixture = await EditingFixture.mount(tester, 'editor');
      final result = await fixture.invoke('find_widget', {});
      final widget = result['widget'] as Map<String, dynamic>;
      final rect = tester.getRect(find.byType(EditableText));
      expect(widget['inputBounds'], {
        'x': rect.left,
        'y': rect.top,
        'width': rect.width,
        'height': rect.height,
      });
      expect(widget['bounds'], isNot(widget['inputBounds']));
      final fieldRect = tester.getRect(find.byType(TextField));
      expect(widget['inputFieldBounds'], {
        'x': fieldRect.left,
        'y': fieldRect.top,
        'width': fieldRect.width,
        'height': fieldRect.height,
      });
      expect(widget['inputFieldBounds'], isNot(widget['bounds']));
      await fixture.dispose();
    });
    testWidgets(
      'rejects invalid requests before focus changes an existing selection',
      (tester) async {
        final fixture = await EditingFixture.mount(tester, '😀x', focus: false);
        final before = fixture.controller.value;
        expect(
          await fixture.edit({'action': 'move_cursor', 'offset': 1}),
          containsPair('code', 'INVALID_TEXT_BOUNDARY'),
        );
        expect(fixture.focus.hasFocus, isFalse);
        expect(fixture.controller.value, before);
        await fixture.dispose();
      },
    );

    testWidgets(
      'deletes Unicode clusters using the editor formatter and onChanged',
      (tester) async {
        var formatterCalls = 0;
        final changed = <String>[];
        final fixture = await EditingFixture.mount(
          tester,
          'ab👩‍💻',
          formatters: [
            TextInputFormatter.withFunction((before, after) {
              formatterCalls++;
              return after.copyWith(text: after.text.toUpperCase());
            }),
          ],
          onChanged: changed.add,
        );
        expect(
          await fixture.edit({'action': 'delete'}),
          containsPair('ok', true),
        );
        expect(fixture.controller.text, 'AB');
        expect(
          fixture.controller.selection,
          const TextSelection.collapsed(offset: 2),
        );
        expect(formatterCalls, 1);
        expect(changed, ['AB']);
        await fixture.dispose();
      },
    );

    testWidgets(
      'preserves legal reverse selection and deletes only full clusters',
      (tester) async {
        final fixture = await EditingFixture.mount(tester, 'A😀e\u0301Z');
        expect(
          await fixture.edit({'action': 'select_range', 'start': 5, 'end': 1}),
          containsPair('ok', true),
        );
        expect(fixture.controller.selection.baseOffset, 5);
        expect(fixture.controller.selection.extentOffset, 1);
        expect(
          await fixture.edit({'action': 'delete'}),
          containsPair('ok', true),
        );
        expect(fixture.controller.text, 'AZ');
        expect(
          fixture.controller.selection,
          const TextSelection.collapsed(offset: 1),
        );
        await fixture.dispose();
      },
    );

    testWidgets(
      'rejects externally supplied partial selections for modifying and clipboard actions',
      (tester) async {
        final fixture = await EditingFixture.mount(tester, 'A😀e\u0301Z');
        for (final action in ['delete', 'copy', 'cut', 'paste']) {
          for (final selection in [
            const TextSelection.collapsed(offset: 2),
            const TextSelection(baseOffset: 1, extentOffset: 4),
            const TextSelection(baseOffset: 4, extentOffset: 1),
          ]) {
            fixture.controller.selection = selection;
            final before = fixture.controller.value;
            expect(
              await fixture.edit({'action': action}),
              containsPair('code', 'INVALID_TEXT_BOUNDARY'),
            );
            expect(fixture.controller.value, before);
          }
        }
        await fixture.dispose();
      },
    );
  });
}

class EditingFixture {
  EditingFixture(this.tester, this.controller, this.focus);
  final WidgetTester tester;
  final TextEditingController controller;
  final FocusNode focus;
  final results = <String, Map<String, dynamic>>{};
  late final runtime = createUi((kind, event) {
    results[event['operationId'] as String] =
        event['result'] as Map<String, dynamic>;
  });
  var sequence = 0;

  static Future<EditingFixture> mount(
    WidgetTester tester,
    String text, {
    bool focus = true,
    List<TextInputFormatter>? formatters,
    ValueChanged<String>? onChanged,
  }) async {
    final controller = TextEditingController.fromValue(
      TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      ),
    );
    final node = FocusNode();
    final fixture = EditingFixture(tester, controller, node);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Padding(
            key: const ValueKey('input'),
            padding: const EdgeInsets.all(16),
            child: TextField(
              decoration: const InputDecoration(
                labelText: 'Fixture editor',
                helperText: 'Editor bounds',
              ),
              controller: controller,
              focusNode: node,
              inputFormatters: formatters,
              onChanged: onChanged,
            ),
          ),
        ),
      ),
    );
    if (focus) {
      node.requestFocus();
      await tester.pump();
    }
    return fixture;
  }

  Future<Map<String, dynamic>> edit(Map<String, dynamic> args) =>
      invoke('edit_text', args);

  Future<Map<String, dynamic>> invoke(
    String tool,
    Map<String, dynamic> args,
  ) async {
    final id = '${++sequence}';
    runtime['launch'](
      id,
      tool,
      jsonEncode({
        'key': {'type': 'string', 'value': 'input'},
        ...args,
      }),
    );
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      if (results.containsKey(id)) return results.remove(id)!;
    }
    throw StateError('The injected edit operation did not complete');
  }

  Future<void> dispose() async {
    runtime['active'] = false;
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    focus.dispose();
  }
}
