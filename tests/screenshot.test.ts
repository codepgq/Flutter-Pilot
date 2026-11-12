import { describe, expect, it, vi } from 'vitest';
import { composeScreenshot, takeAppScreenshot, type ScreenshotHost } from '../src/screenshot';

import { PNG } from 'pngjs';
const source = new PNG({ width: 2, height: 2 });
source.data.fill(255);
const png = PNG.sync.write(source);
const capture = { ok: true, width: 2, height: 2, parts: [{ png: png.toString('base64') }] };
function fixture(mode: 'screen' | 'long' = 'screen') {
  const host: ScreenshotHost = {
    execute: vi.fn().mockResolvedValue({ ok: true, targets: [{ id: 'list', label: 'List' }] }),
    chooseMode: vi.fn().mockResolvedValue(mode),
    chooseTarget: vi.fn().mockResolvedValue({ id: 'right', label: 'Right' }),
    destination: vi.fn().mockResolvedValue('/tmp/app.png'),
    capture: vi.fn().mockResolvedValue(capture),
    save: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue(undefined),
  };
  return host;
}
describe('App screenshot workflow', () => {
  it('saves and previews the captured screen after choosing a path', async () => {
    const host = fixture();
    await takeAppScreenshot(host);
    expect(host.execute).not.toHaveBeenCalled();
    expect(host.capture).toHaveBeenCalledWith({ mode: 'screen' });
    expect(host.save).toHaveBeenCalledWith('/tmp/app.png', png);
    expect(host.preview).toHaveBeenCalledWith('/tmp/app.png');
  });
  it('automatically selects the unique scrolling region for long screenshots', async () => {
    const host = fixture('long');
    await takeAppScreenshot(host);
    expect(host.capture).toHaveBeenCalledWith({ mode: 'long', targetId: 'list' });
    expect(host.chooseTarget).not.toHaveBeenCalled();
  });
  it('requires an explicit choice between parallel scroll regions', async () => {
    const host = fixture('long');
    vi.mocked(host.execute).mockResolvedValue({ ok: true, targets: [{ id: 'left' }, { id: 'right' }] });
    await takeAppScreenshot(host);
    expect(host.chooseTarget).toHaveBeenCalledOnce();
    expect(host.capture).toHaveBeenCalledWith({ mode: 'long', targetId: 'right' });
  });
  it('does not scroll or write files if the user cancels the destination', async () => {
    const host = fixture('long');
    vi.mocked(host.destination).mockResolvedValue(undefined);
    await takeAppScreenshot(host);
    expect(host.capture).not.toHaveBeenCalled();
    expect(host.save).not.toHaveBeenCalled();
  });
  it('does not start if the mode choice is cancelled', async () => {
    const host = fixture();
    vi.mocked(host.chooseMode).mockResolvedValue(undefined);
    await takeAppScreenshot(host);
    expect(host.destination).not.toHaveBeenCalled();
  });
  it('reports empty or failed enumeration without capturing an incomplete long image', async () => {
    const host = fixture('long');
    vi.mocked(host.execute).mockResolvedValue({ ok: true, targets: [] });
    await expect(takeAppScreenshot(host)).rejects.toThrow('没有可见');
    vi.mocked(host.execute).mockResolvedValue({ ok: false, message: '连接已断开' });
    await expect(takeAppScreenshot(host)).rejects.toThrow('连接已断开');
    expect(host.capture).not.toHaveBeenCalled();
  });
  it('discards cancelled and failed captures, including limits and changed pages', async () => {
    const host = fixture();
    vi.mocked(host.capture).mockResolvedValue({ ok: false, code: 'CANCELLED' });
    await takeAppScreenshot(host);
    vi.mocked(host.capture).mockResolvedValue({ ok: false, code: 'CAPTURE_LIMIT', message: '内容超过限制' });
    await expect(takeAppScreenshot(host)).rejects.toThrow('内容超过限制');
    expect(host.save).not.toHaveBeenCalled();
    expect(host.preview).not.toHaveBeenCalled();
  });
  it('rejects invalid PNG data before writing, and never previews a failed write', async () => {
    const host = fixture();
    vi.mocked(host.capture).mockResolvedValue({ ...capture, parts: [{ png: 'invalid' }] });
    await expect(takeAppScreenshot(host)).rejects.toThrow('PNG');
    expect(host.save).not.toHaveBeenCalled();
    vi.mocked(host.capture).mockResolvedValue(capture);
    vi.mocked(host.save).mockRejectedValue(new Error('disk full'));
    await expect(takeAppScreenshot(host)).rejects.toThrow('disk full');
    expect(host.preview).not.toHaveBeenCalled();
  });
});

describe('long PNG composition', () => {
  it('preserves every pixel across boundaries beyond the mobile GPU texture limit', () => {
    const red = new PNG({ width: 2, height: 5000 });
    const blue = new PNG({ width: 2, height: 5000 });
    for (let i = 0; i < red.data.length; i += 4) {
      red.data.set([255, 0, 0, 255], i);
      blue.data.set([0, 0, 255, 255], i);
    }
    const result = composeScreenshot({
      ok: true,
      width: 2,
      height: 10000,
      parts: [red, blue].map((image) => ({ png: PNG.sync.write(image).toString('base64') })),
    });
    const output = PNG.sync.read(result);
    expect(output.width).toBe(2);
    expect(output.height).toBe(10000);
    expect(output.data.subarray(4999 * 8, 4999 * 8 + 4)).toEqual(Buffer.from([255, 0, 0, 255]));
    expect(output.data.subarray(5000 * 8, 5000 * 8 + 4)).toEqual(Buffer.from([0, 0, 255, 255]));
    expect(output.data.subarray(-4)).toEqual(Buffer.from([0, 0, 255, 255]));
  });
  it('rejects truncated, mismatched and oversized strips before saving', () => {
    expect(() => composeScreenshot({ ...capture, height: 3 })).toThrow('不完整');
    expect(() => composeScreenshot({ ...capture, width: 3 })).toThrow('尺寸');
    expect(() => composeScreenshot({ ...capture, height: 30001 })).toThrow('尺寸');
    expect(() => composeScreenshot({ ...capture, width: 4096, height: 10000 })).toThrow('尺寸');
  });
});
