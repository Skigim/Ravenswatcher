// Backend selection: the one place that maps a platform to its ProcessBackend.
// Callers use getProcessBackend() rather than requiring a platform module, so
// adding a backend is a change here and nowhere else.

import type { ProcessBackend, ProcessErrorCode } from './process';

export function getProcessBackend(platform: NodeJS.Platform = process.platform): ProcessBackend {
  if (platform === 'win32') {
    // Required lazily: win32 loads kernel32 through koffi at import time,
    // which must not happen on a platform that has no such library.
    const win32: typeof import('./win32') = require('./win32');
    return win32.win32Backend;
  }
  throw Object.assign(
    new Error(`process backend: platform '${platform}' is unsupported`),
    { code: 'EUNSUPPORTED' satisfies ProcessErrorCode },
  );
}
