'use strict';
// Worker-thread entry for buildAssets. The build is CPU work -- about a
// second for 155 icons on the machine it was measured on, most of it BC3
// decoding and PNG deflate -- and main.js is the UI thread, so it runs here
// and posts the tables back. workerData is a BuildOptions; the reply is
// {tables} or {error: message}. Nothing else crosses.

import { parentPort, workerData } from 'worker_threads';
import { buildAssets, BuildOptions } from './build';

// Only ever loaded as a worker, where parentPort is set.
if (parentPort === null) throw new Error('build-worker.js runs as a worker thread only');
const port = parentPort;

try {
  const tables = buildAssets(workerData as BuildOptions);
  port.postMessage({ tables });
} catch (e) {
  port.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
