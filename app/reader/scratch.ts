// Reusable native-facing scratch buffers. Platform independent: nothing here
// touches an OS API, so scan.js and any process backend share one definition.
//
// A plain Node Buffer, NOT koffi.alloc + koffi.view.
//
// koffi.view() wraps external memory in an ArrayBuffer via
// napi_create_external_arraybuffer. Node allows that; Electron does not --
// its V8 sandbox rejects external backing stores, and the failure is not an
// exception you can catch but a hard `FATAL ERROR: Error::New
// napi_get_last_error_info` that kills the process. It reproduces on the
// first view() call under both the dev electron binary and the packaged app,
// on koffi 2.16.3 and 3.1.6 alike, while plain `node` runs the same code
// fine. Since this reader exists to run inside Electron, view() is
// unavailable here regardless of what it does elsewhere.
//
// A Buffer costs nothing to substitute: koffi passes a Buffer or TypedArray
// to a `void *` parameter as its data pointer, so ReadProcessMemory still
// writes straight into the memory the scan loop reads, with no marshalling
// copy. Measured after the swap, throughput was unchanged.
//
// allocUnsafeSlow, not allocUnsafe: pooled Buffers share one ArrayBuffer at a
// non-zero byteOffset, and every view below would silently address the wrong
// slice of the pool.

export interface Scratch {
  /** The Buffer itself, passed to native calls as a `void *` data pointer. */
  ptr: Buffer;
  ab: ArrayBufferLike;
  size: number;
  u8: Uint8Array;
  dv: DataView;
}

export function scratch(size: number): Scratch {
  const buf = Buffer.allocUnsafeSlow(size);
  const ab = buf.buffer;
  return {
    ptr: buf, ab, size,
    u8: new Uint8Array(ab, buf.byteOffset, size),
    dv: new DataView(ab, buf.byteOffset, size),
  };
}
