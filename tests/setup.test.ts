import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applySetup,
  generateHelper,
  getSetupState,
  inspectFlutterProject,
  prepareSetup,
  revertSetup,
} from '../src/setup';

const certificate = '-----BEGIN CERTIFICATE-----\ndGVzdA==\n-----END CERTIFICATE-----\n';
const roots: string[] = [];
async function project(
  source = "import 'package:dio/dio.dart';\n\nFuture<void> main() async {\n  final dio = Dio();\n  await dio.get('/hello');\n}\n",
  pubspec = 'name: setup_test\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.9.0\n',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flutter-pilot-setup-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'lib'));
  await fs.writeFile(path.join(root, 'pubspec.yaml'), pubspec);
  await fs.writeFile(path.join(root, 'lib', 'main.dart'), source);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Flutter 接入', () => {
  it('生成可预览补丁，保持默认信任和调试双重开关，并完整撤销', async () => {
    const root = await project();
    const original = await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8');
    const inspection = await inspectFlutterProject(root);
    expect(inspection.supported).toBe(true);
    expect(inspection.candidates).toHaveLength(1);
    expect(inspection.candidates[0].automatic).toBe(true);
    const preview = await prepareSetup(root, inspection.candidates[0], certificate);
    expect(await getSetupState(root)).toBeNull();
    expect(preview.files[1].after).toContain("import 'flutter_pilot_debug.dart';");
    expect(preview.files[1].after).toContain('final dio = Dio();\n  await configureFlutterPilot(dio);');
    expect(await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8')).toBe(original);
    const helper = preview.files[0].after;
    expect(helper).toContain('if (!kDebugMode) return;');
    expect(helper).toContain("String.fromEnvironment('FLUTTER_PILOT_PROXY')");
    expect(helper).toContain('SecurityContext(withTrustedRoots: true)');
    expect(helper).not.toContain('badCertificateCallback');
    await applySetup(preview);
    expect((await getSetupState(root))?.files).toHaveLength(2);
    const reverted = await revertSetup(root);
    expect(reverted.reverted).toHaveLength(2);
    expect(reverted.preserved).toEqual([]);
    expect(await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8')).toBe(original);
    expect(await getSetupState(root)).toBeNull();
    await expect(fs.access(path.join(root, 'lib', 'flutter_pilot_debug.dart'))).rejects.toThrow();
  });

  it('源码在预览后改变时拒绝应用', async () => {
    const root = await project();
    const inspection = await inspectFlutterProject(root);
    const preview = await prepareSetup(root, inspection.candidates[0], certificate);
    await fs.appendFile(path.join(root, 'lib', 'main.dart'), '// user change\n');
    await expect(applySetup(preview)).rejects.toThrow('预览后文件已变化');
    await expect(fs.access(path.join(root, 'lib', 'flutter_pilot_debug.dart'))).rejects.toThrow();
  });

  it('撤销保留用户后续编辑及关联 helper，避免破坏导入', async () => {
    const root = await project();
    const inspection = await inspectFlutterProject(root);
    await applySetup(await prepareSetup(root, inspection.candidates[0], certificate));
    await fs.appendFile(path.join(root, 'lib', 'main.dart'), '// preserved edit\n');
    const result = await revertSetup(root);
    expect(result.reverted).toEqual([]);
    expect(result.preserved).toHaveLength(2);
    expect(await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8')).toContain('// preserved edit');
    expect(await getSetupState(root)).not.toBeNull();
  });

  it('忽略注释和字符串，支持带类型及复杂参数的声明', async () => {
    const root = await project(`import 'package:dio/dio.dart';
// final ignored = Dio();
const text = 'final ignoredToo = Dio();';
Future<void> main() async {
  final Dio client = Dio(BaseOptions(baseUrl: 'https://example.com/a;{}'));
}
`);
    const inspection = await inspectFlutterProject(root);
    expect(inspection.candidates.map((item) => item.variable)).toEqual(['client']);
    expect(inspection.candidates[0].automatic).toBe(true);
    const preview = await prepareSetup(root, inspection.candidates[0], certificate);
    expect(preview.files[1].after).toContain(
      "baseUrl: 'https://example.com/a;{}'));\n  await configureFlutterPilot(client);",
    );
  });

  it('同步函数、嵌套同步闭包和自定义适配器只提供手动片段', async () => {
    for (const source of [
      'Dio build() { final dio = Dio(); return dio; }',
      'Future<void> main() async { void build() { final dio = Dio(); } }',
      'Future<void> main() async { final dio = Dio(); dio.httpClientAdapter = CustomAdapter(); }',
    ]) {
      const root = await project(source);
      const inspection = await inspectFlutterProject(root);
      expect(inspection.candidates[0].automatic).toBe(false);
      const preview = await prepareSetup(root, inspection.candidates[0], certificate);
      expect(preview.files).toHaveLength(1);
      expect(preview.manualSnippet).toContain('await configureFlutterPilot(dio);');
    }
  });

  it('不覆盖已有 helper，不接受过期或越界候选项', async () => {
    const root = await project();
    const { candidates } = await inspectFlutterProject(root);
    await expect(
      prepareSetup(root, { ...candidates[0], file: path.join(root, '..', 'outside.dart') }, certificate),
    ).rejects.toThrow('项目内');
    await expect(prepareSetup(root, { ...candidates[0], offset: 0 }, certificate)).rejects.toThrow(
      '源码已变化',
    );
    await fs.writeFile(path.join(root, 'lib', 'flutter_pilot_debug.dart'), '// user file');
    await expect(prepareSetup(root, candidates[0], certificate)).rejects.toThrow('已存在');
  });

  it('不修改符号链接文件', async () => {
    const root = await project();
    const external = await project();
    await fs.symlink(path.join(external, 'lib', 'main.dart'), path.join(root, 'lib', 'linked.dart'));
    const inspection = await inspectFlutterProject(root);
    expect(inspection.candidates).toHaveLength(1);
    await expect(
      prepareSetup(
        root,
        { ...inspection.candidates[0], file: path.join(root, 'lib', 'linked.dart') },
        certificate,
      ),
    ).rejects.toThrow('符号链接');
  });

  it('以 lockfile 中的精确版本判定兼容性', async () => {
    const root = await project(undefined, 'name: app\ndependencies:\n  dio: any\n');
    expect((await inspectFlutterProject(root)).supported).toBe(false);
    await fs.writeFile(
      path.join(root, 'pubspec.lock'),
      'packages:\n  dio:\n    dependency: "direct main"\n    description:\n      name: dio\n      url: "https://pub.dev"\n    source: hosted\n    version: "5.9.0"\n  other:\n    version: "1.0.0"\n',
    );
    const inspection = await inspectFlutterProject(root);
    expect(inspection.supported).toBe(true);
    expect(inspection.dioVersion).toBe('5.9.0');
  });

  it('拒绝无效 CA，未找到项目时给出诊断', async () => {
    expect(() => generateHelper('not a certificate')).toThrow('无效');
    const root = await project();
    await fs.rm(path.join(root, 'pubspec.yaml'));
    expect((await inspectFlutterProject(root)).diagnostics[0]).toContain('没有 pubspec.yaml');
  });

  it('逐个接入多个 Dio 实例并保持整体撤销基线', async () => {
    const root = await project(
      "import 'package:dio/dio.dart';\nFuture<void> main() async {\n  final first = Dio();\n  final second = Dio();\n}\n",
    );
    const original = await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8');
    let inspection = await inspectFlutterProject(root);
    await applySetup(await prepareSetup(root, inspection.candidates[0], certificate));
    inspection = await inspectFlutterProject(root);
    expect(inspection.candidates.find((item) => item.variable === 'first')?.automatic).toBe(false);
    const second = inspection.candidates.find((item) => item.variable === 'second')!;
    expect(second.automatic).toBe(true);
    await applySetup(await prepareSetup(root, second, certificate));
    const source = await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8');
    expect(source).toContain('await configureFlutterPilot(first);');
    expect(source).toContain('await configureFlutterPilot(second);');
    expect(source.match(/import 'flutter_pilot_debug.dart';/g)).toHaveLength(1);
    await revertSetup(root);
    expect(await fs.readFile(path.join(root, 'lib', 'main.dart'), 'utf8')).toBe(original);
    await expect(fs.access(path.join(root, 'lib', 'flutter_pilot_debug.dart'))).rejects.toThrow();
  });
});
