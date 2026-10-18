// A saved run rendered in an isolated offscreen page; clipboard changes only
// after a complete, validated capture. No game reads or asset decoding here.
import { BrowserWindow, clipboard, type NativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { StoredRun } from './history';

export interface ShareOptions {
  findRun(id: number): StoredRun | undefined;
  cacheDir(): string | null;
  writeImage?(image: NativeImage): void;
  timeoutMs?: number;
}
export class RunSharer {
  private busy = false;
  constructor(private readonly options: ShareOptions) {}
  async share(input: unknown): Promise<{ok: boolean; error?: string}> {
    const request = input as {runId?: unknown; stylizedFonts?: unknown} | null;
    if (!request || !Number.isSafeInteger(request.runId) || typeof request.stylizedFonts !== 'boolean') return {ok:false,error:'Invalid share request.'};
    if (this.busy) return {ok:false,error:'Another run image is being copied.'};
    const run = this.options.findRun(request.runId as number);
    if (!run) return {ok:false,error:'This run is no longer available.'};
    this.busy = true;
    let win: BrowserWindow | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    try {
      // Snapshot before awaiting so history refresh/deletion cannot change it.
      const snapshot = JSON.parse(JSON.stringify(run)) as StoredRun;
      let tables: unknown = {};
      const cacheDir = this.options.cacheDir();
      if (cacheDir) {
        try { tables = JSON.parse(fs.readFileSync(path.join(cacheDir,'tables.json'),'utf8')); }
        catch { /* names and placeholder art still make a useful share */ }
      }
      win = new BrowserWindow({
        width:1602,height:1002,useContentSize:true,show:false,
        webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false},
      });
      win.setMenu(null);
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.webContents.on('will-navigate',event=>event.preventDefault());
      const view = win;
      const capture = async () => {
        await view.loadFile(path.join(__dirname,'web','share.html'));
        const model = {run:snapshot,tables,stylizedFonts:request.stylizedFonts};
        const bounds: {width:number;height:number} = await view.webContents.executeJavaScript(`renderShare(${JSON.stringify(model)})`);
        if (cancelled) throw new Error('Share cancelled.');
        if (bounds.width!==1600 || !Number.isInteger(bounds.height) || bounds.height<1000 || bounds.height>16000) throw new Error('This run image is too large to copy.');
        // Leave two CSS pixels around the capture to absorb Windows fractional-DPI rounding.
        view.setContentSize(bounds.width+2,bounds.height+2);
        await view.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const captured = await view.webContents.capturePage({x:0,y:0,...bounds});
        if (cancelled) throw new Error('Share cancelled.');
        const size = captured.getSize();
        const scale = size.width / bounds.width;
        const [viewWidth=0,viewHeight=0] = view.getContentSize();
        if (captured.isEmpty() || !(scale>0) || Math.abs(size.height-bounds.height*scale)>1 || viewWidth<bounds.width || viewHeight<bounds.height) {
          console.error('[share] Incomplete capture', {bounds,scale,size,contentSize:view.getContentSize()});
          throw new Error('Could not capture the complete run image.');
        }
        // The image representation is normalized to one PNG pixel per CSS pixel,
        // independent of the display scale where the main app is running.
        const image = captured.resize({width:bounds.width,height:bounds.height,quality:'best'});
        (this.options.writeImage ?? (image=>clipboard.writeImage(image)))(image);
      };
      await Promise.race([capture(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{cancelled=true;reject(new Error('Run image timed out. Please try again.'));},this.options.timeoutMs ?? 15000);
      })]);
      return {ok:true};
    } catch (error) {
      return {ok:false,error:error instanceof Error?error.message:'Could not copy this run.'};
    } finally {
      cancelled=true;if(timer)clearTimeout(timer);
      if(win&&!win.isDestroyed())win.destroy();
      this.busy=false;
    }
  }
}
