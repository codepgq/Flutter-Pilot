import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, platform, arch, release } from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { productionHost } from './web-test-support.mjs';
const exec = promisify(execFile),
  root = resolve('.');
const temp = await mkdtemp(join(tmpdir(), 'pilot-delivery-'));
const artifact = resolve(
  'artifacts/web-flutter-runtime/phase-07',
  new Date().toISOString().replace(/[:.]/g, '-') + '-delivery',
);
await mkdir(artifact, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function bridge(path) {
  const samples = [];
  for (let n = 0; n < 3; n++) {
    const client = new Client({ name: 'isolated-package-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path, '--registry', join(temp, 'empty-registry')],
      stderr: 'pipe',
    });
    const start = performance.now();
    try {
      await client.connect(transport);
      const tools = await client.listTools(),
        prompts = await client.listPrompts();
      assert.ok(tools.tools.length > 0 && prompts.prompts.length > 0);
      for (const t of tools.tools)
        assert.ok(
          prompts.prompts.some((p) => p.name === t.name),
          t.name,
        );
      await client.getPrompt({ name: 'capabilities' });
      await client.getPrompt({ name: 'get_usage_guide' });
      const ms = performance.now() - start;
      const rss = Number((await exec('ps', ['-o', 'rss=', '-p', String(transport.pid)])).stdout.trim());
      samples.push({
        initializeDiscoveryMs: ms,
        rssKiB: rss,
        toolCount: tools.tools.length,
        promptCount: prompts.prompts.length,
      });
    } finally {
      await client.close();
    }
  }
  return samples;
}
let browser;
try {
  const baseline = join(temp, 'baseline');
  await mkdir(baseline);
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const tar = join(temp, 'base.tar');
  await exec('git', ['archive', 'HEAD', '-o', tar], { cwd: root });
  await exec('tar', ['-xf', tar, '-C', baseline]);
  await symlink(join(root, 'node_modules'), join(baseline, 'node_modules'));
  await exec(process.execPath, ['scripts/build.mjs'], { cwd: baseline });
  const vsce = join(root, 'node_modules/@vscode/vsce/vsce');
  const before = join(artifact, 'baseline.vsix'),
    after = join(artifact, 'final.vsix');
  const packageArgs = (out) => [
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--no-rewrite-relative-links',
    '--out',
    out,
  ];
  await exec(process.execPath, [vsce, ...packageArgs(before)], { cwd: baseline, maxBuffer: 4 * 1024 * 1024 });
  await exec(process.execPath, [vsce, ...packageArgs(after)], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const entries = (await exec('unzip', ['-Z1', after])).stdout.trim().split('\n');
  for (const name of [
    'dist/browser-worker.cjs',
    'dist/mcp-bridge.cjs',
    'resources/browser/package.json',
    'resources/browser/package-lock.json',
    'resources/example.web-scenes.json',
  ])
    assert.ok(entries.includes('extension/' + name), name);
  assert.ok(
    !entries.some((p) =>
      /node_modules|\/artifacts\/|\.flutter-pilot\/|ServerCertificate|\/Default\/|\.key$|auth\.json/.test(p),
    ),
    'private state excluded',
  );
  const extracted = join(temp, 'extracted');
  await exec('unzip', ['-q', after, '-d', extracted]);
  const files = [];
  for (const path of entries.filter((p) =>
    /^extension\/(dist\/.*\.(cjs|js|css)|resources\/browser\/.*|package.json)$/.test(p),
  )) {
    const relative = path.slice('extension/'.length),
      bytes = await readFile(join(extracted, path));
    assert.equal(hash(bytes), hash(await readFile(join(root, relative))));
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  const baselineSamples = await bridge(join(baseline, 'dist/mcp-bridge.cjs'));
  const finalSamples = await bridge(join(extracted, 'extension/dist/mcp-bridge.cjs'));
  const { BrowserController } = await productionHost();
  browser = new BrowserController({
    project: { projectId: 'delivery', workspacePath: temp },
    rulesDirectory: join(temp, '.flutter-pilot'),
    storage: resolve('artifacts/web-flutter-runtime/browser-validation'),
    resources: resolve('resources/browser'),
    workerPath: join(extracted, 'extension/dist/browser-worker.cjs'),
  });
  assert.equal(browser.worker.running, false);
  const start = performance.now();
  const context = await browser.execute('create_browser_context', {});
  const browserStartupMs = performance.now() - start;
  const workerRssKiB = Number(
    (await exec('ps', ['-o', 'rss=', '-p', String(browser.worker.child.pid)])).stdout.trim(),
  );
  await browser.execute('close_browser_context', { target: context });
  await browser.dispose();
  browser = undefined;
  const report = {
    commit,
    environment: { node: process.version, platform: platform(), arch: arch(), release: release() },
    measurement:
      'Three sequential fresh Node stdio initializations plus tool/prompt discovery; RSS sampled after discovery. Package built from HEAD and dirty final sources with identical dependencies. Browser separately measured once; no SLA inferred.',
    baseline: { packageBytes: (await stat(before)).size, samples: baselineSamples },
    final: { packageBytes: (await stat(after)).size, samples: finalSamples, browserStartupMs, workerRssKiB },
    files,
    packageSha256: hash(await readFile(after)),
    entries,
  };
  await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifact, baseline: report.baseline, final: report.final }));
} finally {
  await browser?.dispose();
  await rm(temp, { recursive: true, force: true });
}
