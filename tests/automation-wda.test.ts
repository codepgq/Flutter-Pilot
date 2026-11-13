import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  attachAdapterVersion,
  AutomationRuntime,
  patchManagedSimulatorAttach,
} from '../src/automation/runtime';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-wda-ownership-'));
  roots.push(root);
  return root;
}
const startupPath = 'node_modules/appium-xcuitest-driver/build/lib/commands/wda/startup.js';
// The pinned driver's two launch paths share this cleanup function. Keep its
// signature and ownership filter identical to 12.22.8 so the adapter runs here.
const startupSource = `
export async function preparePreinstalled(driver) {
    const candidateBundleId = await driver.appInfosCache.extractBundleId(driver.opts.prebuiltWDAPath);
    await cleanupApps(driver, [candidateBundleId]);
    driver.installed.push(candidateBundleId);
}
export async function prepareForXcodebuild(driver) {
    if (await driver.wda.setupCaching()) return;
    await cleanupApps(driver, [driver.opts.updatedWDABundleId + '.xctrunner']);
}
async function cleanupApps(driver, keepBundleIds = []) {
    const installedBundleIds = await driver.device.getUserInstalledBundleIdsByBundleName('WebDriverAgentRunner-Runner');
    const keep = new Set(keepBundleIds.filter(Boolean));
    for (const bundleId of installedBundleIds.filter((id) => !keep.has(id))) {
        await driver.device.removeApp(bundleId);
    }
}
`;
async function installAdapterFixture(root: string) {
  const files = [
    [
      'node_modules/appium-xcuitest-driver/build/lib/commands/simulator.js',
      'export async function startSim() { return await this.device.run(); }',
    ],
    [
      'node_modules/appium-xcuitest-driver/build/lib/commands/wda/stop.js',
      'if ((!this.wda.webDriverAgentUrl && this.opts.useNewWDA) || this.wda.canSkipXcodebuild) { await this.wda.quit(); }',
    ],
    [
      'node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/build/lib/utils/processes.js',
      'export async function resetTestProcesses(udid, isSimulator) { throw new Error("unrelated process cleanup"); }',
    ],
    [startupPath, startupSource],
  ];
  for (const [file, source] of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
}
function startupModule(source: string, attachOnly: boolean) {
  return runInNewContext(
    source.replace(/^export /gm, '') + '\n({ preparePreinstalled, prepareForXcodebuild })',
    { process: { env: { FLUTTER_PILOT_ATTACH_ONLY: attachOnly ? '1' : '0' } } },
  ) as Record<string, (driver: unknown) => Promise<void>>;
}
function driver() {
  return {
    opts: { prebuiltWDAPath: '/fixture/signed.app', updatedWDABundleId: 'pilot.fixture' },
    appInfosCache: { extractBundleId: async () => 'pilot.fixture.xctrunner' },
    wda: { setupCaching: async () => false },
    installed: [] as string[],
    device: {
      getUserInstalledBundleIdsByBundleName: vi.fn(async () => [
        'pilot.fixture.xctrunner',
        'another.team.xctrunner',
        'another.tool.xctrunner',
      ]),
      removeApp: vi.fn(async (_bundleId: string) => {}),
    },
  };
}

describe('managed WDA ownership', () => {
  it.each(['preparePreinstalled', 'prepareForXcodebuild'])(
    'preserves every unrelated WDA in %s while allowing its own launch to continue',
    async (path) => {
      const root = await temp();
      await installAdapterFixture(root);
      await patchManagedSimulatorAttach(root);
      const patched = await readFile(join(root, startupPath), 'utf8');
      const attached = driver();
      await startupModule(patched, true)[path](attached);
      expect(attached.device.removeApp).not.toHaveBeenCalled();
      expect(attached.device.getUserInstalledBundleIdsByBundleName).not.toHaveBeenCalled();
      if (path === 'preparePreinstalled') expect(attached.installed).toEqual(['pilot.fixture.xctrunner']);

      // Prove this fixture exercises the destructive upstream branch without
      // the attach guard rather than passing because the path is unreachable.
      const upstream = driver();
      await startupModule(patched, false)[path](upstream);
      expect(upstream.device.removeApp.mock.calls).toEqual([
        ['another.team.xctrunner'],
        ['another.tool.xctrunner'],
      ]);
      await patchManagedSimulatorAttach(root);
      expect(await readFile(join(root, startupPath), 'utf8')).toBe(patched);
    },
  );
  it('rejects a changed WDA cleanup signature instead of publishing an unsafe adapter', async () => {
    const root = await temp();
    await installAdapterFixture(root);
    await writeFile(join(root, startupPath), startupSource.replace('keepBundleIds = []', 'keepIds = []'));
    await expect(patchManagedSimulatorAttach(root)).rejects.toMatchObject({
      code: 'DRIVER_ADAPTER_MISMATCH',
    });
  });
  it.each(['current-lock', 'previous-lock'])(
    'refuses a v2 adapter with %s even through the previous-installation fallback',
    async (lock) => {
      const root = await temp(),
        resources = join(root, 'resources'),
        managed = join(root, 'managed'),
        installed = join(managed, 'runtimes', 'abc123');
      await mkdir(resources, { recursive: true });
      const lockHash = createHash('sha256').update('current-lock').digest('hex');
      const storedHash = lock === 'current-lock' ? lockHash : 'previous-lock-hash';
      await writeFile(join(resources, 'package-lock.json'), 'current-lock');
      await mkdir(join(installed, 'node_modules', 'appium', 'build', 'lib'), { recursive: true });
      await writeFile(join(installed, 'node_modules', 'appium', 'build', 'lib', 'main.js'), '');
      const pointer = JSON.stringify({ directory: 'abc123', lockHash: storedHash });
      await writeFile(join(managed, 'current.json'), pointer);
      await writeFile(
        join(installed, 'receipt.json'),
        JSON.stringify({ lockHash: storedHash, attachAdapterVersion: 2, versions: {} }),
      );
      const runtime = new AutomationRuntime({ root: managed, resources, nodePath: process.execPath });
      vi.spyOn(runtime as any, 'run').mockImplementation(async (file: unknown) =>
        String(file).includes('npm') ? '10.9.0' : 'v24.0.0',
      );
      try {
        expect(attachAdapterVersion).toBeGreaterThan(2);
        expect((await runtime.inspect(false)).installed).toBe(false);
        await expect(runtime.start()).rejects.toMatchObject({ code: 'AUTOMATION_NOT_PREPARED' });
        expect(await readFile(join(managed, 'current.json'), 'utf8')).toBe(pointer);
      } finally {
        await runtime.dispose();
      }
    },
  );
});
