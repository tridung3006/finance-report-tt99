const assert = require("node:assert/strict");
const {
  B02_TT99_TARGETS,
  applyHistoricalB02Prior,
  convertTt200Month,
  monthsInClosedRange,
  queryHistoricalB02Prior,
} = require("./b02-history.cjs");
const { b02Lines } = require("./index.cjs");

function sourceMap(values) {
  return new Map(Object.entries(values).map(([code, amount], index) => [code, { amount, cell: `D${index + 1}` }]));
}

async function run() {
  assert.deepEqual(
    B02_TT99_TARGETS.map(([code, label]) => [code, label]),
    b02Lines.map(([code, label]) => [code, label]),
    "Historical target codes and labels must exactly match the app B02 template",
  );

  const converted = convertTt200Month(sourceMap({
    "01": 1_000,
    "04": 10,
    "05": 20,
    "06": 30,
    "11": 400,
    "21": 50,
    "22": 20,
    "23": 12,
    "25": 100,
    "26": 80,
    "31A": 90,
    "31B": 40,
    "31C": 15,
    "32A": 70,
    "32B": 20,
    "32C": 5,
    "51": 6,
    "52": 4,
  }));
  const byCode = new Map(converted.map((row) => [row.targetLineCode, row]));
  assert.equal(byCode.get("02").amount, 60);
  assert.equal(byCode.get("10").amount, 940);
  assert.equal(byCode.get("20").amount, 540);
  assert.equal(byCode.get("22").amount, 50);
  assert.equal(byCode.get("23").amount, 20);
  assert.equal(byCode.get("24").amount, 12);
  assert.equal(byCode.get("30").amount, 390);
  assert.equal(byCode.get("31").amount, 65);
  assert.equal(byCode.get("32").amount, 55);
  assert.equal(byCode.get("40").amount, 10);
  assert.equal(byCode.get("50").amount, 400);
  assert.equal(byCode.get("60").amount, 390);
  for (const code of ["21", "70", "71"]) {
    assert.equal(byCode.get(code).amount, null);
    assert.equal(byCode.get(code).valueStatus, "unavailable");
  }

  assert.equal(monthsInClosedRange("2025-01-01", "2025-12-31").length, 12);
  assert.equal(monthsInClosedRange("2025-03-01", "2025-05-31").length, 3);
  assert.equal(monthsInClosedRange("2025-01-02", "2025-01-31"), null);
  assert.equal(monthsInClosedRange("2025-01-01", "2025-01-30"), null);

  const completeRows = B02_TT99_TARGETS.map(([code]) => ({
    target_line_code: code,
    row_count: 12,
    available_count: ["21", "70", "71"].includes(code) ? 0 : 12,
    amount: ["21", "70", "71"].includes(code) ? null : "1200",
  }));
  const calls = [];
  const completeClient = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: completeRows };
    },
  };
  const history2025 = await queryHistoricalB02Prior(completeClient, "2025-01-01", "2025-12-31");
  assert.equal(history2025.applicable, true);
  assert.equal(history2025.monthCount, 12);
  assert.deepEqual(calls[0].params, [2025, 1, 2025, 12]);
  assert.equal(history2025.values.get("01"), 1200);
  assert.equal(history2025.values.get("21"), null);

  const reportRows = [{ code: "01", current: 9, prior: 7 }, { code: "21", current: 3, prior: 2 }];
  assert.deepEqual(applyHistoricalB02Prior(reportRows, history2025), [
    { code: "01", current: 9, prior: 1200 },
    { code: "21", current: 3, prior: null },
  ]);

  const noHistory = await queryHistoricalB02Prior({ query: async () => ({ rows: [] }) }, "2026-01-01", "2026-12-31");
  assert.equal(noHistory.applicable, false);
  assert.equal(noHistory.reason, "not-found");
  assert.deepEqual(applyHistoricalB02Prior(reportRows, noHistory), reportRows, "2027 must fall back to dynamic 2026 journal data");

  const partial = await queryHistoricalB02Prior({ query: async () => { throw new Error("must not query"); } }, "2025-01-02", "2025-01-31");
  assert.equal(partial.reason, "partial-month-range");

  console.log("B02 historical mapping tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
