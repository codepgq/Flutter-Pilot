import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestError, validateTestDocument, type TestDocument } from './model';

/** Project-owned definitions are loaded explicitly; reads never create a file. */
export class TestStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, 'tests.json');
  }
  async read(): Promise<TestDocument> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new TestError('INVALID_TEST_FILE', '测试配置目录必须是普通目录。');
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
        throw new TestError('INVALID_TEST_FILE', '测试配置必须位于普通目录中，使用不超过 2 MiB 的普通文件。');
      const contents = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(contents) > 2 * 1024 * 1024)
        throw new TestError('INVALID_TEST_FILE', '测试配置最多 2 MiB。');
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        throw new TestError('INVALID_TEST_FILE', 'tests.json 不是有效 JSON。');
      }
      return validateTestDocument(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tests: [] };
      throw error;
    }
  }
}
