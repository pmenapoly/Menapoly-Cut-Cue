// Hashes a File in 8 MiB slices off the main thread and reports measured progress.
import { Sha256 } from "./sha256.js";

self.onmessage = async (event) => {
  const file = event.data.file;
  const hash = new Sha256();
  const step = 8 * 1024 * 1024;
  try {
    for (let offset = 0; offset < file.size; offset += step) {
      hash.update(new Uint8Array(await file.slice(offset, offset + step).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (offset + step) / file.size) });
    }
    self.postMessage({ sha256: hash.hex() });
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
