import type { UiResult } from './vm/ui';
import { PNG } from 'pngjs';

export interface ScreenshotHost {
  execute(tool: string, args?: Record<string, unknown>): Promise<UiResult>;
  chooseMode(): Promise<'screen' | 'long' | undefined>;
  chooseTarget(targets: ScreenshotTarget[]): Promise<ScreenshotTarget | undefined>;
  destination(mode: 'screen' | 'long'): Promise<string | undefined>;
  capture(args: Record<string, unknown>): Promise<UiResult>;
  save(path: string, png: Buffer): Promise<void>;
  preview(path: string): Promise<void>;
}
export interface ScreenshotTarget {
  id: string;
  label: string;
  description?: string;
}

/** Stitch bounded PNG strips in CPU memory so mobile GPU texture limits cannot truncate the image. */
export function composeScreenshot(result: UiResult): Buffer {
  const { width, height } = result;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < 1 ||
    (width as number) > 4096 ||
    (height as number) < 1 ||
    (height as number) > 30000 ||
    (width as number) * (height as number) > 24_000_000 ||
    !Array.isArray(result.parts) ||
    result.parts.length < 1 ||
    result.parts.length > 34
  )
    throw new Error('Flutter 返回了无效的截图尺寸。');
  const output = new PNG({ width: width as number, height: height as number });
  let row = 0;
  let encodedLength = 0;
  for (const part of result.parts) {
    if (typeof part?.png !== 'string') throw new Error('Flutter 返回了无效的 PNG 分段。');
    encodedLength += part.png.length;
    if (encodedLength > 28_000_000) throw new Error('截图数据超过限制。');
    const png = Buffer.from(part.png, 'base64');
    if (
      png.length < 24 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(16) !== width ||
      png.readUInt32BE(20) < 1 ||
      png.readUInt32BE(20) > 8192 ||
      row + png.readUInt32BE(20) > (height as number)
    )
      throw new Error('Flutter 返回了无效的 PNG 分段尺寸。');
    const image = PNG.sync.read(png, { checkCRC: true });
    image.data.copy(output.data, row * (width as number) * 4);
    row += image.height;
  }
  if (row !== height) throw new Error('截图分段不完整，未保存图片。');
  return PNG.sync.write(output);
}

/** Shared workflow for the launcher command and the workbench header. */
export async function takeAppScreenshot(host: ScreenshotHost): Promise<void> {
  const mode = await host.chooseMode();
  if (!mode) return;
  let targetId: string | undefined;
  if (mode === 'long') {
    const result = await host.execute('screenshot_targets');
    if (!result.ok) throw new Error(result.message ?? '无法读取滚动区域。');
    const targets = result.targets as ScreenshotTarget[];
    if (!targets?.length) throw new Error('当前页面没有可见的向下滚动区域，请选择“当前屏幕”。');
    const target = targets.length === 1 ? targets[0] : await host.chooseTarget(targets);
    if (!target) return;
    targetId = target.id;
  }
  const path = await host.destination(mode);
  if (!path) return;
  const result = await host.capture({ mode, ...(targetId ? { targetId } : {}) });
  if (!result.ok) {
    if (result.code === 'CANCELLED') return;
    throw new Error(result.message ?? 'Flutter 截图失败。');
  }
  const png = composeScreenshot(result);
  await host.save(path, png);
  await host.preview(path);
}
