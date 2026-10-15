// The browser's streaming SHA-256 (cloud/web/sha256.js) must match Node's for every padding edge case.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Sha256 } from "../../web/sha256.js";

test("streaming SHA-256 matches node:crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 1 << 20, 5 * (1 << 20) + 7]) {
    const data = randomBytes(n);
    const hash = new Sha256();
    for (let i = 0; i < n; i += 4099) hash.update(new Uint8Array(data.subarray(i, i + 4099)));
    assert.equal(hash.hex(), createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});
