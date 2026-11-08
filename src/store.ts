import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuleDocument, validateRuleDocument } from './model';
export class RuleStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, 'rules.json');
  }
  async load(): Promise<RuleDocument> {
    try {
      return validateRuleDocument(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rules: [] };
      throw new Error(`无法读取规则文件 ${this.file}：${(e as Error).message}`);
    }
  }
  async save(document: unknown): Promise<RuleDocument> {
    const validated = validateRuleDocument(document);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `rules.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(validated, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    return validated;
  }
}
