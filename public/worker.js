// Reads a PLY file off the main thread and hands back transferable arrays.
import { readPly, PlyError } from './ply.js';

self.onmessage = async ({ data: { file } }) => {
  try {
    const source = {
      size: file.size,
      read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    };
    let last = 0;
    const cloud = await readPly(source, {
      onProgress(phase, fraction) {
        const now = performance.now();
        if (now - last < 50 && fraction < 1) return;
        last = now;
        self.postMessage({ type: 'progress', phase, fraction });
      },
    });
    const transfer = [cloud.positions.buffer];
    if (cloud.colors) transfer.push(cloud.colors.buffer);
    self.postMessage({ type: 'done', cloud }, transfer);
  } catch (err) {
    const message = err instanceof PlyError
      ? err.message
      : err instanceof RangeError
        ? 'This file has more points than this browser can hold in memory.'
        : `Could not read this file: ${err.message}`;
    self.postMessage({ type: 'error', message });
  }
};
