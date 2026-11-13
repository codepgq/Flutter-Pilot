import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWorkflowDocument, WorkflowError, type WorkflowDocument } from './model';

/** Workflows are project-owned definitions. Reading never creates or overwrites a file. */
export class WorkflowStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, 'workflows.json');
  }
  async read(): Promise<WorkflowDocument> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new WorkflowError('INVALID_WORKFLOW_FILE', '工作流目录必须是普通目录，不能使用符号链接。');
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
        throw new WorkflowError('INVALID_WORKFLOW_FILE', '工作流文件必须是普通文件，且最多 2 MiB。');
      const contents = await readFile(this.file, 'utf8');
      if (Buffer.byteLength(contents) > 2 * 1024 * 1024)
        throw new WorkflowError('INVALID_WORKFLOW_FILE', '工作流文件最多 2 MiB。');
      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        throw new WorkflowError('INVALID_WORKFLOW_FILE', 'workflows.json 不是有效 JSON，请修复后重试。');
      }
      return validateWorkflowDocument(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workflows: [] };
      throw error;
    }
  }
}
