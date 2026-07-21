const assert = require("node:assert/strict");
const { periodOpeningBalanceDate, queryTrialBalanceRawSource } = require("./index.cjs");

function mockClient() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
}

async function run() {
  assert.equal(periodOpeningBalanceDate("2026-01-01"), "2025-12-31");
  assert.equal(periodOpeningBalanceDate("2027-01-01"), "2026-12-31");

  const exactClient = mockClient();
  await queryTrialBalanceRawSource(exactClient, {
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    accountCode: "331119",
    accountAnalytic: "Dũng Hàng E01979",
    analyticFilter: "dũng hàng",
    groupByAnalytic: false,
    page: 1,
    pageSize: 1000,
  });
  assert.match(exactClient.calls[0].sql, /trim\(coalesce\(account_analytic, ''\)\) = \$4/);
  assert.equal(exactClient.calls[0].values[3], "Dũng Hàng E01979");
  assert.doesNotMatch(exactClient.calls[0].sql, /posting_date <>/);

  const filteredClient = mockClient();
  await queryTrialBalanceRawSource(filteredClient, {
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    accountCode: "331119",
    accountAnalytic: "",
    analyticFilter: "dũng hàng",
    groupByAnalytic: false,
    page: 1,
    pageSize: 1000,
  });
  assert.match(filteredClient.calls[0].sql, /trim\(coalesce\(account_analytic, ''\)\) ilike \$4/);
  assert.equal(filteredClient.calls[0].values[3], "%dũng hàng%");
  console.log("trial balance raw-source predicate tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
