const assert = require("node:assert/strict");
const { fullMonthRange, latestSnapshotDate, monthEnd, monthStart } = require("./report-aggregates.cjs");

assert.equal(monthStart("2026-07-16"), "2026-07-01");
assert.equal(monthEnd("2026-02-10"), "2026-02-28");
assert.equal(monthEnd("2028-02-10"), "2028-02-29");
assert.deepEqual(fullMonthRange("2026-01-01", "2026-06-30"), { first: "2026-01-01", last: "2026-06-30" });
assert.deepEqual(fullMonthRange("2026-01-15", "2026-03-31"), { first: "2026-02-01", last: "2026-03-31" });
assert.equal(fullMonthRange("2026-07-01", "2026-07-10"), null);

async function run() {
  const client = {
    async query(sql, values) {
      assert.match(sql, /from public\.monthly_report_aggregate_controls/);
      assert.deepEqual(values, ["2026-06-30"]);
      return { rows: [{ snapshot_date: "2026-06-30" }] };
    },
  };
  assert.equal(await latestSnapshotDate(client, "2026-06-30"), "2026-06-30");
  console.log("report aggregate helper tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
