import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WsRule, WsRuleDocument } from './model';

import { validateWsRuleDocument } from './model';
export { validateWsRuleDocument, wsUrlMatches } from './model';

const maxDocumentBytes = 2 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Project-owned WS rules, with atomic writes and protection against external edits. */
export class WsRuleStore {
  readonly file: string;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {
    this.file = join(directory, 'ws-rules.json');
  }
  private async checkDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WS 规则目录必须是项目内的普通目录');
  }
  private async text(): Promise<string | undefined> {
    await this.checkDirectory();
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('WS 规则必须使用普通文件，不能使用符号链接');
      if (info.size > maxDocumentBytes) throw new Error('WS 规则文档最多 2 MiB');
      return await readFile(this.file, 'utf8');
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  private parse(text: string): WsRuleDocument {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('ws-rules.json 不是有效 JSON，请修复后读取项目文件');
    }
    return validateWsRuleDocument(value, false);
  }
  async load(): Promise<WsRuleDocument> {
    let text = await this.text();
    if (text === undefined) {
      const temporary = join(this.directory, `.ws-rules-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, '{"version":1,"rules":[]}\n', { flag: 'wx', mode: 0o600 });
        try {
          await link(temporary, this.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      text = await this.text();
    }
    if (text === undefined) throw new Error('无法创建 WS 规则文件');
    return this.parse(text);
  }
  save(rules: WsRule[] | WsRuleDocument, expectedRules: WsRule[]): Promise<WsRuleDocument> {
    const document = validateWsRuleDocument(Array.isArray(rules) ? { version: 1, rules } : rules, false);
    const expected = JSON.stringify(expectedRules);
    const operation = this.operations.then(async () => {
      const before = await this.text();
      if (before === undefined || JSON.stringify(this.parse(before).rules) !== expected)
        throw new Error('WS 规则文件已被修改，请先点击“读取项目文件”，再编辑规则');
      const temporary = join(this.directory, `.ws-rules-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        if ((await this.text()) !== before) throw new Error('WS 规则文件已被修改，请先读取项目文件');
        await rename(temporary, this.file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return document;
    });
    this.operations = operation.catch(() => undefined);
    return operation;
  }
}
