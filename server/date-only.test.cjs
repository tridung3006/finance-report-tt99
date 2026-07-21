const assert = require("node:assert/strict");
const { dateOnly } = require("./index.cjs");

assert.equal(dateOnly("2025-12-31"), "2025-12-31");
assert.equal(dateOnly("2025-12-30T17:00:00.000Z"), "2025-12-31");
assert.equal(dateOnly(new Date("2025-12-30T17:00:00.000Z")), "2025-12-31");

console.log("backend date-only tests passed");
