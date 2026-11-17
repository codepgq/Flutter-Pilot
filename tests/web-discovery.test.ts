import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverWebProject, validateWebProject } from '../src/discovery';
import { openProjectBinding } from '../src/project';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-web-project-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it.each(['react', 'vue', 'vite'])(
  'discovers %s declarations without running a server or writing config',
  async (name) => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { [name]: '1.0.0' } }));
    expect(await discoverWebProject(root)).toEqual({ root: '.', framework: name });
  },
);
it('does not treat plain Node or an unregistered HTML directory as a Web project', async () => {
  expect(await discoverWebProject(root)).toBeUndefined();
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '1.0.0' } }));
  expect(await discoverWebProject(root)).toBeUndefined();
});
it('registers HTML and a mixed-repository subproject without changing the UUID or Scene library', async () => {
  await mkdir(join(root, 'frontend'));
  await writeFile(
    join(root, 'frontend/package.json'),
    JSON.stringify({ dependencies: { vue: '1.0.0', vite: '1.0.0' } }),
  );
  const binding = await openProjectBinding(root, join(root, 'private'));
  const id = binding.projectId;
  await binding.registerWeb({ url: 'http://localhost:5173', root: 'frontend' });
  expect(binding.projectId).toBe(id);
  expect(binding.config).toMatchObject({
    connection: { mode: 'proxy' },
    web: { root: 'frontend', framework: 'vue', url: 'http://localhost:5173/' },
  });
  expect(await discoverWebProject(root)).toEqual(binding.config.web);
  await binding.registerWeb({ url: 'https://127.0.0.1:8443/', root: '.' });
  expect((await binding.reload()).web?.framework).toBe('html');
});
it.each([
  'https://user:pass@localhost:443',
  'file:///tmp/page.html',
  'http://example.com',
  'javascript:alert(1)',
])('rejects invalid local URL %s', async (url) => {
  await expect(validateWebProject(root, { url, root: '.' })).rejects.toThrow();
});
it('rejects traversal and symlink roots outside the workspace', async () => {
  await expect(validateWebProject(root, { url: 'http://localhost', root: '..' })).rejects.toThrow('越出');
  await symlink(tmpdir(), join(root, 'escape'));
  await expect(validateWebProject(root, { url: 'http://localhost', root: 'escape' })).rejects.toThrow('越出');
});
