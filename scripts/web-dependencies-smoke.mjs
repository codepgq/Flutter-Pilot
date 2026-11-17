import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { productionHost } from './web-test-support.mjs';
const { BrowserDependencies } = await productionHost();
const root = await mkdtemp(join(tmpdir(), 'pilot-browser-prepare-'));
const artifact = resolve(
  'artifacts/web-flutter-runtime/phase-03',
  new Date().toISOString().replace(/[:.]/g, '-') + '-dependency-lifecycle',
);
const runtime = new BrowserDependencies(join(root, 'runtime'), resolve('resources/browser'));
const cancel = new AbortController();
const abort = () => cancel.abort();
runtime.once('progress', abort);
try {
  assert.equal((await runtime.status()).prepared, false);
  await assert.rejects(
    () => runtime.prepare(cancel.signal),
    (error) => error.code === 'CANCELLED',
  );
  assert.deepEqual(await readdir(root), []);
  await runtime.prepare();
  const receipt = await runtime.status();
  assert.equal(receipt.prepared, true);
  const file = join(root, 'runtime/receipt.json'),
    original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('1.65.0', '0.0.0'));
  assert.equal((await runtime.status()).prepared, false);
  await writeFile(file, original);
  assert.equal((await runtime.prepare()).prepared, true);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(artifact, { recursive: true });
  await writeFile(
    join(artifact, 'report.json'),
    JSON.stringify(
      {
        passed: 5,
        cancelledInFlight: true,
        noStagingLeak: true,
        explicitRetryInstalled: true,
        corruptionDiagnosed: true,
        receipt,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: 5, artifact }));
} finally {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
