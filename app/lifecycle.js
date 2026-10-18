'use strict';

// Keep a second launch from disappearing while the first instance drains its reader.
function createLifecycle({ stop, quit, relaunch, focus, onError = console.error }) {
  let closing = false;
  let readyToQuit = false;
  let relaunchRequested = false;
  let relaunchScheduled = false;
  let shutdown = null;
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

module.exports = { createLifecycle };
