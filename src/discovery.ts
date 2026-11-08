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
