// A saved run rendered in an isolated offscreen page; clipboard changes only
// after a complete, validated capture. No game reads or asset decoding here.
import { BrowserWindow, clipboard, type NativeImage } from 'electron';
import * as path from 'path';
import type { StoredRun } from './history';

export interface ShareOptions {
  findRun(id: number): StoredRun | undefined;
  tables(): unknown;
  writeImage?(image: NativeImage): void;
  timeoutMs?: number;
}

export class RunSharer {
  private busy = false;

  constructor(private readonly options: ShareOptions) {}

  async share(input: unknown): Promise<{ ok: boolean; error?: string }> {
    const request = input as { runId?: unknown; stylizedFonts?: unknown } | null;
    if (!request || !Number.isSafeInteger(request.runId) || typeof request.stylizedFonts !== 'boolean') {
      return { ok: false, error: 'Invalid share request.' };
    }
    if (this.busy) {
      return { ok: false, error: 'Another run image is being copied.' };
    }
    const run = this.options.findRun(request.runId as number);
    if (!run) {
      return { ok: false, error: 'This run is no longer available.' };
    }

    this.busy = true;
    let win: BrowserWindow | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWaitingForPaint: (() => void) | undefined;
    let cancelled = false;

    try {
      // Snapshot before awaiting so history refresh/deletion cannot change it.
      const snapshot = JSON.parse(JSON.stringify(run)) as StoredRun;
      const tables = this.options.tables() ?? {};
      win = new BrowserWindow({
        width: 1602,
        height: 1002,
        useContentSize: true,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.setMenu(null);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());

      const view = win;
      const capture = async () => {
        await view.loadFile(path.join(__dirname, 'web', 'share.html'));
        const model = {
          run: snapshot,
          tables,
          stylizedFonts: request.stylizedFonts,
        };
        const bounds: { width: number; height: number } = await view.webContents.executeJavaScript(
          `renderShare(${JSON.stringify(model)})`,
        );
        if (cancelled) throw new Error('Share cancelled.');
        if (
          bounds.width !== 1600
          || !Number.isInteger(bounds.height)
          || bounds.height < 1000
          || bounds.height > 16000
        ) {
          throw new Error('This run image is too large to copy.');
        }

        // Leave two CSS pixels around the capture to absorb Windows fractional-DPI rounding.
        view.setContentSize(bounds.width + 2, bounds.height + 2);
        const viewport: { width: number; height: number } = await view.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight }))))',
        );

        // Offscreen rendering already provides a bitmap. capturePage asks Viz
        // to copy a surface again, which can fail with UnknownVizError on
        // software-rendered Windows runners. Request a fresh painted frame.
        const [viewWidth = 0, viewHeight = 0] = view.getContentSize();
        const frame = await new Promise<NativeImage>((resolve) => {
          const onPaint = (_event: Electron.Event, _dirty: Electron.Rectangle, image: NativeImage) => {
            const size = image.getSize();
            // Native window sizes can round differently at fractional DPI;
            // match the bitmap to the renderer's actual CSS viewport.
            const scale = size.width / viewport.width;
            // Ignore an empty or stale frame from before the resize.
            if (image.isEmpty() || !(scale > 0) || Math.abs(size.height - viewport.height * scale) > 1) {
              return;
            }
            stopWaitingForPaint?.();
            resolve(image);
          };
          stopWaitingForPaint = () => view.webContents.removeListener('paint', onPaint);
          view.webContents.on('paint', onPaint);
          view.webContents.invalidate();
        });
        if (cancelled) throw new Error('Share cancelled.');

        const frameScale = frame.getSize().width / viewport.width;
        const captured = frame.crop({
          x: 0,
          y: 0,
          width: Math.round(bounds.width * frameScale),
          height: Math.round(bounds.height * frameScale),
        });
        const size = captured.getSize();
        const scale = size.width / bounds.width;
        if (
          captured.isEmpty()
          || !(scale > 0)
          || Math.abs(size.height - bounds.height * scale) > 1
          || viewWidth < bounds.width
          || viewHeight < bounds.height
        ) {
          console.error('[share] Incomplete capture', {
            bounds,
            scale,
            size,
            contentSize: view.getContentSize(),
          });
          throw new Error('Could not capture the complete run image.');
        }

        // The image representation is normalized to one PNG pixel per CSS pixel,
        // independent of the display scale where the main app is running.
        const image = captured.resize({
          width: bounds.width,
          height: bounds.height,
          quality: 'best',
        });
        const writeImage = this.options.writeImage ?? ((img: NativeImage) => clipboard.writeImage(img));
        writeImage(image);
      };

      await Promise.race([
        capture(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancelled = true;
            reject(new Error('Run image timed out. Please try again.'));
          }, this.options.timeoutMs ?? 15000);
        }),
      ]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not copy this run.',
      };
    } finally {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stopWaitingForPaint?.();
      if (win && !win.isDestroyed()) win.destroy();
      this.busy = false;
    }
  }
}

