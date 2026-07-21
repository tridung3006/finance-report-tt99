const assert = require("node:assert/strict");
const {
  addMonths,
  lastClosedMonth,
  monthEnd,
  monthStart,
  monthsBetween,
  normalizeMonth,
} = require("./snapshots.cjs");

assert.equal(normalizeMonth("2026-02"), "2026-02");
assert.throws(() => normalizeMonth("02/2026"), /YYYY-MM/);
assert.equal(addMonths("2026-01", -1), "2025-12");
assert.equal(addMonths("2026-12", 1), "2027-01");
assert.equal(monthStart("2026-02"), "2026-02-01");
assert.equal(monthEnd("2026-02"), "2026-02-28");
assert.equal(monthEnd("2028-02"), "2028-02-29");
assert.deepEqual(monthsBetween("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
assert.deepEqual(monthsBetween("2025-12", "2026-02"), ["2025-12", "2026-01", "2026-02"]);
assert.equal(lastClosedMonth(new Date("2026-07-16T01:00:00.000Z"), "Asia/Ho_Chi_Minh"), "2026-06");

console.log("snapshot helper tests passed");
