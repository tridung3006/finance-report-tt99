import assert from "node:assert/strict";
import { normalizeDateOnly } from "./dateOnly";

assert.equal(normalizeDateOnly("2025-12-31"), "2025-12-31");
assert.equal(normalizeDateOnly("2025-12-30T17:00:00.000Z"), "2025-12-31");
assert.equal(normalizeDateOnly(new Date("2025-12-30T17:00:00.000Z")), "2025-12-31");

console.log("frontend date-only tests passed");
