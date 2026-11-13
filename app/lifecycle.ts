'use strict';

// Keep a second launch from disappearing while the first instance drains its reader.

export interface LifecycleOptions {
  stop: () => unknown;
  quit: () => void;
  relaunch: () => void;
  focus: () => void;
  onError?: (error: unknown) => void;
}

export interface Lifecycle {
  beforeQuit(event: { preventDefault(): void }): Promise<void> | undefined;
  secondInstance(): void;
}

export function createLifecycle({ stop, quit, relaunch, focus, onError = console.error }: LifecycleOptions): Lifecycle {
  let closing = false;
  let readyToQuit = false;
  let relaunchRequested = false;
  let relaunchScheduled = false;
  let shutdown: Promise<void> | null = null;
  const scheduleRelaunch = () => {
    if (relaunchRequested && !relaunchScheduled) {
      relaunchScheduled = true;
      relaunch();
    }
  };
  return {
    beforeQuit(event) {
      if (readyToQuit) return;
      event.preventDefault();
      if (shutdown) return shutdown;
      closing = true;
      shutdown = Promise.resolve().then(stop).catch(onError).then(() => {
        readyToQuit = true;
        scheduleRelaunch();
        quit();
      });
      return shutdown;
    },
    secondInstance() {
      if (closing) {
        relaunchRequested = true;
        if (readyToQuit) scheduleRelaunch();
      } else focus();
    },
  };
}
