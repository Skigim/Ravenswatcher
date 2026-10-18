import type { MessagePort } from 'worker_threads';

/** Stop only between synchronous operations; never terminate a native call. */
export class WorkerControl {
  stopped = false;
  private wake: (() => void) | null = null;
  private readonly onMessage = (message: unknown): void => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'stop') this.stop();
  };

  constructor(private readonly port: MessagePort | null) {
    port?.on('message', this.onMessage);
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }

  dispose(): void {
    this.stop();
    this.port?.removeListener('message', this.onMessage);
  }
}
