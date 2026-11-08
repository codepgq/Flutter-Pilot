import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SetupCandidate {
  id: string;
  file: string;
  variable: string;
  offset: number;
  automatic: boolean;
  reason?: string;
}

export interface FlutterInspection {
  root: string;
  pubspecPath: string;
  dioVersion?: string;
  supported: boolean;
  diagnostics: string[];
  candidates: SetupCandidate[];
}

export interface SetupFileChange {
  path: string;
  before: string | null;
  after: string;
}

export interface SetupPreview {
  id: string;
  root: string;
  files: SetupFileChange[];
  candidate: SetupCandidate;
  manualSnippet?: string;
  previousStateId?: string;
}

interface SetupState {
  version: 1;
  id: string;
  appliedAt: string;
  files: Array<SetupFileChange & { appliedHash: string }>;
}

const helperName = 'api_mocks_debug.dart';
const stateName = path.join('.dart_tool', 'api_mocks_setup.json');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

async function assertSafePath(root: string, file: string): Promise<void> {
  if (!contained(root, file)) throw new Error('接入文件必须位于当前 Flutter 项目内。');
  const relative = path.relative(root, file);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error('接入向导不会修改符号链接，请手动接入。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Replace Dart comments and string contents with spaces, preserving source offsets. */
function maskDart(source: string): string {
  const chars = source.split('');
  let i = 0;
  const erase = (index: number): void => {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  };
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') erase(i++);
    } else if (source.startsWith('/*', i)) {
      let depth = 1;
      erase(i++);
      erase(i++);
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) {
          depth++;
          erase(i++);
          erase(i++);
        } else if (source.startsWith('*/', i)) {
          depth--;
          erase(i++);
          erase(i++);
        } else erase(i++);
      }
    } else if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      const delimiter = source.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      const raw = i > 0 && source[i - 1] === 'r' && (i < 2 || !/[\w$]/.test(source[i - 2]));
      for (let n = 0; n < delimiter.length; n++) erase(i++);
      while (i < source.length && !source.startsWith(delimiter, i)) {
        if (!raw && source[i] === '\\') {
          erase(i++);
          if (i < source.length) erase(i++);
        } else erase(i++);
      }
      for (let n = 0; n < delimiter.length && i < source.length; n++) erase(i++);
    } else i++;
  }
  return chars.join('');
}

function scanCandidates(source: string, file: string): SetupCandidate[] {
  const masked = maskDart(source);
  const asyncBodies = new Set<number>();
  const functionPattern = /\b(?:Future(?:\s*<[^{};]+>)?|void)\s+[\w$]+\s*\([^{};]*\)\s+async\s*\{/g;
  for (const match of masked.matchAll(functionPattern))
    asyncBodies.add(match.index! + match[0].lastIndexOf('{'));
  const declaration =
    /\b(?:final\s+(?:Dio\s+)?|Dio\s+)([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?Dio\s*\(/g;
  const adapterCustomization =
    /\b(?:httpClientAdapter|HttpOverrides|badCertificateCallback|validateCertificate|onHttpClientCreate|createHttpClient)\b/.test(
      masked,
    );
  const result: SetupCandidate[] = [];
  for (const match of masked.matchAll(declaration)) {
    let end = match.index! + match[0].length;
    let depth = 1;
    while (end < masked.length && depth > 0) {
      if (masked[end] === '(') depth++;
      if (masked[end] === ')') depth--;
      end++;
    }
    while (/\s/.test(masked[end] ?? '') && end < masked.length) end++;
    if (masked[end] !== ';') continue;
    end++;
    const braces: number[] = [];
    for (let index = 0; index < match.index!; index++) {
      if (masked[index] === '{') braces.push(index);
      if (masked[index] === '}') braces.pop();
    }
    let reason: string | undefined;
    if (adapterCustomization)
      reason = '文件中存在网络适配器、证书或 HttpOverrides 配置，需要人工确认兼容性。';
    else if (
      new RegExp(`\\bconfigureApiMocks\\s*\\(\\s*${match[1].replace(/[$]/g, '\\$&')}\\s*\\)`).test(masked)
    )
      reason = '此 Dio 实例已经调用 configureApiMocks，请检查现有接入。';
    else if (!asyncBodies.has(braces.at(-1) ?? -1))
      reason = '仅支持在明确的 async 函数直接作用域内自动插入；此处请使用手动片段。';
    else if (/\bpart\s+of\b/.test(masked)) reason = 'part 文件需要在所属 library 中手动添加导入。';
    result.push({
      id: `${file}:${match.index}`,
      file,
      variable: match[1],
      offset: end,
      automatic: !reason,
      ...(reason ? { reason } : {}),
    });
  }
  return result;
}

async function dartFiles(directory: string, result: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (result.length >= 2000) break;
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) await dartFiles(file, result);
    else if (
      entry.isFile() &&
      entry.name.endsWith('.dart') &&
      !entry.name.endsWith('.g.dart') &&
      entry.name !== helperName
    )
      result.push(file);
  }
  return result;
}

export async function inspectFlutterProject(root: string): Promise<FlutterInspection> {
  root = await fs.realpath(root);
  const pubspecPath = path.join(root, 'pubspec.yaml');
  const pubspec = await readOptional(pubspecPath);
  const diagnostics: string[] = [];
  if (!pubspec)
    return {
      root,
      pubspecPath,
      supported: false,
      diagnostics: ['当前目录没有 pubspec.yaml，请打开 Flutter 项目根目录。'],
      candidates: [],
    };
  const dio = /^\s{2}dio:\s*([^\n#]*)/m.exec(pubspec);
  let dioVersion = dio?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (dio && !dioVersion) {
    const rest = pubspec.slice(dio.index + dio[0].length);
    dioVersion = /^\s{4}version:\s*([^\n#]+)/m
      .exec(rest.split(/\n(?=\S| {2}\S)/)[0])?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
  }
  // A lockfile gives a precise version for `any`, overrides and loose ranges.
  const lock = await readOptional(path.join(root, 'pubspec.lock'));
  const lockedVersion = lock
    ? /^ {2}dio:\n(?:(?: {4,}[^\n]*|\s*)\n)*? {4}version:\s*["']?([^\s"']+)/m.exec(lock)?.[1]
    : undefined;
  const supported =
    !!dio && (lockedVersion ? /^5\./.test(lockedVersion) : /(?:^|[\s^~>=])5\./.test(dioVersion ?? ''));
  if (!dio) diagnostics.push('未发现直接 Dio 依赖。若使用 Retrofit 等封装，请定位创建 Dio 的宿主包。');
  else if (!supported)
    diagnostics.push(
      `首版自动接入仅支持 Dio 5；当前声明：${dioVersion || '无法判断'}${lockedVersion ? `，锁定版本：${lockedVersion}` : ''}。`,
    );
  const files = await dartFiles(path.join(root, 'lib'));
  const candidates = (
    await Promise.all(files.map(async (file) => scanCandidates(await fs.readFile(file, 'utf8'), file)))
  ).flat();
  if (candidates.length === 0)
    diagnostics.push('未找到可识别的 Dio 实例，请在实际创建 Dio 的位置手动调用接入片段。');
  if (candidates.length > 1)
    diagnostics.push(`发现 ${candidates.length} 个 Dio 实例，请逐个确认实际使用的客户端。`);
  if (await getSetupState(root))
    diagnostics.push('当前项目已有接入记录，可继续接入其他 Dio 实例；更新证书前建议先撤销旧接入。');
  return {
    root,
    pubspecPath,
    ...(lockedVersion || dioVersion ? { dioVersion: lockedVersion || dioVersion } : {}),
    supported,
    diagnostics,
    candidates,
  };
}

export function generateHelper(caPem: string): string {
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----\s*$/.test(caPem.trim()))
    throw new Error('无效的代理 CA 公钥证书。请先启动代理生成证书。');
  const certificate = Buffer.from(caPem.trim(), 'utf8').toString('base64');
  return `// Generated by Flutter API Mocks. Contains a PUBLIC CA certificate only.\n// Enable only with: flutter run --dart-define=API_MOCK_PROXY=host:port\nimport 'dart:convert';\nimport 'dart:io';\n\nimport 'package:dio/dio.dart';\nimport 'package:dio/io.dart';\nimport 'package:flutter/foundation.dart';\n\n/// 为当前 Dio 实例开启显式启用的开发代理。Release/Profile 构建保持原配置。\nFuture<void> configureApiMocks(Dio dio) async {\n  if (!kDebugMode) return;\n  const proxy = String.fromEnvironment('API_MOCK_PROXY');\n  if (proxy.isEmpty) return;\n  final address = Uri.tryParse('http://$proxy');\n  if (address == null || address.host.isEmpty || !address.hasPort ||\n      address.port < 1 || address.port > 65535 || address.userInfo.isNotEmpty ||\n      address.path.isNotEmpty || address.hasQuery || address.hasFragment) {\n    throw ArgumentError('API_MOCK_PROXY 必须为 host:port。');\n  }\n  final adapter = dio.httpClientAdapter;\n  if (adapter is! IOHttpClientAdapter) {\n    throw StateError('API Mocks 仅支持 Dio IOHttpClientAdapter；请保留自定义适配器并手动接入。');\n  }\n  // 检查旧 Dio 5 的自定义入口，避免静默覆盖项目网络配置。\n  // ignore: deprecated_member_use\n  final legacyFactory = adapter.onHttpClientCreate;\n  if (adapter.createHttpClient != null || adapter.validateCertificate != null || legacyFactory != null) {\n    throw StateError('发现自定义 HttpClient 或证书校验。API Mocks 未覆盖现有配置，请手动合并。');\n  }\n  final context = SecurityContext(withTrustedRoots: true);\n  context.setTrustedCertificatesBytes(base64Decode('${certificate}'));\n  adapter.createHttpClient = () {\n    final client = HttpClient(context: context);\n    client.findProxy = (_) => 'PROXY $proxy';\n    return client;\n  };\n}\n`;
}

function insertImport(source: string, importPath: string): string {
  const directive = `import '${importPath}';`;
  const matches = [...source.matchAll(/^(?:import|export)\s+[\s\S]*?;[^\S\r\n]*(?:\r?\n|$)/gm)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    const offset = last.index! + last[0].length;
    return source.slice(0, offset) + directive + '\n' + source.slice(offset);
  }
  const library = /^library\b[^;]*;\s*/m.exec(source);
  const offset = library
    ? library.index + library[0].length
    : source.startsWith('#!')
      ? source.indexOf('\n') + 1
      : 0;
  return source.slice(0, offset) + directive + '\n' + source.slice(offset);
}

export async function prepareSetup(
  root: string,
  candidate: SetupCandidate,
  caPem: string,
): Promise<SetupPreview> {
  root = await fs.realpath(root);
  // macOS exposes temporary folders through /var -> /private/var; canonicalize
  // the parent while retaining the final component for the symlink check.
  const requested = path.resolve(candidate.file);
  const file = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  await assertSafePath(root, file);
  const previous = await getSetupState(root);
  const inspection = await inspectFlutterProject(root);
  if (!inspection.supported) throw new Error(inspection.diagnostics[0] ?? '需要 Dio 5 项目。');
  const current = inspection.candidates.find(
    (item) =>
      item.id === candidate.id && item.variable === candidate.variable && item.offset === candidate.offset,
  );
  if (!current) throw new Error('源码已变化，请重新扫描 Dio 实例。');
  const source = await fs.readFile(file, 'utf8');
  const helper = path.join(root, 'lib', helperName);
  await assertSafePath(root, helper);
  const helperBefore = await readOptional(helper);
  const helperState = previous?.files.find((item) => item.path === helper);
  if (helperBefore !== null && (!helperState || digest(helperBefore) !== helperState.appliedHash))
    throw new Error(`文件 lib/${helperName} 已存在或已被修改，向导不会覆盖。`);
  const sourceState = previous?.files.find((item) => item.path === file);
  if (sourceState && digest(source) !== sourceState.appliedHash)
    throw new Error('此前接入的源码已被修改，请先手动合并或恢复后重新扫描。');
  const generated = generateHelper(caPem);
  const relative = path.relative(path.dirname(file), helper).split(path.sep).join('/');
  const snippet = `import '${relative}';\n\n// 在首次发起请求之前执行，使用 --dart-define=API_MOCK_PROXY=host:port 启用。\nawait configureApiMocks(${candidate.variable});`;
  const helperChanges: SetupFileChange[] =
    helperBefore === generated ? [] : [{ path: helper, before: helperBefore, after: generated }];
  const previousStateId = previous?.id;
  if (!current.automatic)
    return {
      id: randomUUID(),
      root,
      candidate: current,
      files: helperChanges,
      manualSnippet: snippet,
      previousStateId,
    };
  const lineStart = source.lastIndexOf('\n', current.offset - 1) + 1;
  const indent = /^[\t ]*/.exec(source.slice(lineStart))![0];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const afterCall =
    source.slice(0, current.offset) +
    `${newline}${indent}await configureApiMocks(${current.variable});` +
    source.slice(current.offset);
  return {
    id: randomUUID(),
    root,
    candidate: current,
    previousStateId,
    files: [
      ...helperChanges,
      {
        path: file,
        before: source,
        after: source.includes(`import '${relative}';`) ? afterCall : insertImport(afterCall, relative),
      },
    ],
  };
}

export async function getSetupState(root: string): Promise<SetupState | null> {
  const file = path.join(root, stateName);
  const raw = await readOptional(file);
  if (raw === null) return null;
  const state = JSON.parse(raw) as SetupState;
  if (state.version !== 1 || !Array.isArray(state.files))
    throw new Error('接入记录版本不受支持，请保留现有文件并手动检查。');
  return state;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function applySetup(preview: SetupPreview): Promise<{ files: string[] }> {
  const root = await fs.realpath(preview.root);
  const previous = await getSetupState(root);
  if (previous?.id !== preview.previousStateId) throw new Error('接入记录已变化，请重新生成补丁。');
  for (const file of preview.files) {
    await assertSafePath(root, file.path);
    if ((await readOptional(file.path)) !== file.before)
      throw new Error('预览后文件已变化，请重新生成补丁。');
  }
  const statePath = path.join(root, stateName);
  await assertSafePath(root, statePath);
  const written: SetupFileChange[] = [];
  try {
    for (const file of preview.files) {
      await atomicWrite(file.path, file.after);
      written.push(file);
    }
    const combined = new Map((previous?.files ?? []).map((file) => [file.path, file]));
    for (const file of preview.files) {
      const original = combined.get(file.path);
      combined.set(file.path, {
        ...file,
        before: original ? original.before : file.before,
        appliedHash: digest(file.after),
      });
    }
    const state: SetupState = {
      version: 1,
      id: preview.id,
      appliedAt: new Date().toISOString(),
      files: [...combined.values()],
    };
    await atomicWrite(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    for (const file of written.reverse()) {
      if ((await readOptional(file.path)) !== file.after) continue;
      if (file.before === null) await fs.rm(file.path, { force: true });
      else await atomicWrite(file.path, file.before);
    }
    throw error;
  }
  return { files: preview.files.map((file) => file.path) };
}

export async function revertSetup(root: string): Promise<{ reverted: string[]; preserved: string[] }> {
  root = await fs.realpath(root);
  const state = await getSetupState(root);
  if (!state) return { reverted: [], preserved: [] };
  for (const file of state.files) {
    await assertSafePath(root, file.path);
    const current = await readOptional(file.path);
    // Preserve the complete patch together: removing the helper alone could break a later-edited import.
    if (current === null || digest(current) !== file.appliedHash)
      return { reverted: [], preserved: state.files.map((item) => item.path) };
  }
  for (const file of [...state.files].reverse()) {
    if (file.before === null) await fs.rm(file.path);
    else await atomicWrite(file.path, file.before);
  }
  await fs.rm(path.join(root, stateName), { force: true });
  return { reverted: state.files.map((file) => file.path), preserved: [] };
}
