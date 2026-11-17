import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const flutterSdk = /^[ \t]+flutter[ \t]*:[ \t]*(?:#.*)?\r?\n[ \t]+sdk[ \t]*:[ \t]*flutter[ \t]*(?:#.*)?\r?$/m;
const maxWorkspaceMembers = 256;

function scalarPath(value: string): string | undefined {
  const scalar = value.trim();
  if (scalar.startsWith('"')) {
    const match = /^"(?:[^"\\]|\\.)*"(?=\s*(?:#|$))/.exec(scalar);
    if (!match) return;
    try {
      return JSON.parse(match[0]) as string;
    } catch {
      return;
    }
  }
  if (scalar.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?=\s*(?:#|$))/.exec(scalar);
    return match?.[1].replace(/''/g, "'");
  }
  const path = scalar.replace(/\s+#.*$/, '').trim();
  return path && !/[\[\]{}*&]/.test(path) ? path : undefined;
}

/** Read explicit Dart workspace members; never crawl the repository or nested workspaces. */
function workspaceMembers(pubspec: string): string[] {
  const lines = pubspec.split(/\r?\n/);
  const start = lines.findIndex((line) => /^workspace\s*:/.test(line));
  if (start < 0) return [];
  const value = lines[start].replace(/^workspace\s*:\s*/, '');
  const inline = /^\[([^\n]*)\]\s*(?:#.*)?$/.exec(value);
  const members: string[] = [];
  if (inline) {
    const parts = inline[1].match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) ?? [];
    for (const part of parts.slice(0, maxWorkspaceMembers)) {
      const path = scalarPath(part);
      if (path) members.push(path);
    }
    return members;
  }
  if (value && !value.startsWith('#')) return [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (!item) break;
    const path = scalarPath(item[1]);
    if (path) members.push(path);
    if (members.length >= maxWorkspaceMembers) break;
  }
  return members;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

export async function isFlutterWorkspace(root: string): Promise<boolean> {
  const pubspec = await readFile(join(root, 'pubspec.yaml'), 'utf8');
  if (flutterSdk.test(pubspec)) return true;
  const members = workspaceMembers(pubspec);
  if (!members.length) return false;
  const canonicalRoot = await realpath(root);
  for (const member of new Set(members)) {
    if (isAbsolute(member)) continue;
    const folder = resolve(root, member);
    if (!within(resolve(root), folder)) continue;
    try {
      const canonicalPubspec = await realpath(join(folder, 'pubspec.yaml'));
      if (!within(canonicalRoot, canonicalPubspec)) continue;
      if (flutterSdk.test(await readFile(canonicalPubspec, 'utf8'))) return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return false;
}

export interface WebProject {
  url?: string;
  root: string;
  framework: 'html' | 'react' | 'vue' | 'vite' | 'web';
}

/** Inspect declarations only. A Node package alone is not a browser project. */
export async function discoverWebProject(root: string): Promise<WebProject | undefined> {
  try {
    const config = JSON.parse(await readFile(join(root, '.flutter-pilot/project.json'), 'utf8'));
    if (config.web) return validateWebProject(root, config.web);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = dependencies.react
      ? 'react'
      : dependencies.vue
        ? 'vue'
        : dependencies.vite
          ? 'vite'
          : undefined;
    return framework ? { root: '.', framework } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function validateWebProject(workspace: string, input: unknown): Promise<WebProject> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Web 配置必须为对象');
  const value = input as Record<string, unknown>;
  if (typeof value.url !== 'string' || value.url.length > 4096)
    throw new Error('请填写 Web 本地 HTTP/HTTPS URL');
  const url = new URL(value.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Web URL 只支持不含凭证的本地 HTTP/HTTPS 地址');
  if (typeof value.root !== 'string' || isAbsolute(value.root))
    throw new Error('Web 子项目根必须为工作区相对路径');
  const canonical = await realpath(workspace);
  const selected = await realpath(resolve(canonical, value.root));
  if (selected !== canonical && !within(canonical, selected)) throw new Error('Web 子项目根不能越出工作区');
  let framework: WebProject['framework'] = 'html';
  try {
    const pkg = JSON.parse(await readFile(join(selected, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    framework = deps.react ? 'react' : deps.vue ? 'vue' : deps.vite ? 'vite' : 'web';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { url: url.href, root: relative(canonical, selected) || '.', framework };
}
