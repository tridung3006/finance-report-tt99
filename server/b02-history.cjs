const B02_TT99_TARGETS = [
  ["01", "1. Doanh thu bán hàng và cung cấp dịch vụ", ["01"], "TT200.01 -> TT99.01"],
  ["02", "2. Các khoản giảm trừ doanh thu", ["04", "05", "06"], "TT200.04 + 05 + 06 -> TT99.02"],
  ["10", "3. Doanh thu thuần về bán hàng và cung cấp dịch vụ (10 = 01 - 02)", ["01", "04", "05", "06"], "TT99.01 - TT99.02"],
  ["11", "4. Giá vốn hàng bán", ["11"], "TT200.11 -> TT99.11"],
  ["20", "5. Lợi nhuận gộp về bán hàng và cung cấp dịch vụ (20 = 10 - 11)", ["01", "04", "05", "06", "11"], "TT99.10 - TT99.11"],
  ["21", "6. Lãi/lỗ của hoạt động bán, thanh lý bất động sản đầu tư", [], "TT200 file has no separate TT99.21 detail", "unavailable"],
  ["22", "7. Doanh thu hoạt động tài chính", ["21"], "TT200.21 -> TT99.22"],
  ["23", "8. Chi phí tài chính", ["22"], "TT200.22 -> TT99.23"],
  ["24", "Trong đó: Chi phí đi vay", ["23"], "TT200.23 -> TT99.24"],
  ["25", "9. Chi phí bán hàng", ["25"], "TT200.25 -> TT99.25"],
  ["26", "10. Chi phí quản lý doanh nghiệp", ["26"], "TT200.26 -> TT99.26"],
  ["30", "11. Lợi nhuận thuần từ hoạt động kinh doanh", ["01", "04", "05", "06", "11", "21", "22", "25", "26"], "TT200.20 + 21 - 22 - 25 - 26"],
  ["31", "12. Thu nhập khác", ["31A", "31B", "31C"], "TT200.31A - 31B + 31C -> TT99.31"],
  ["32", "13. Chi phí khác", ["32A", "32B", "32C"], "TT200.32A - 32B + 32C -> TT99.32"],
  ["40", "14. Lợi nhuận khác (40 = 31 - 32)", ["31A", "31B", "31C", "32A", "32B", "32C"], "TT99.31 - TT99.32"],
  ["50", "15. Tổng lợi nhuận kế toán trước thuế (50 = 30 + 40)", ["01", "04", "05", "06", "11", "21", "22", "25", "26", "31A", "31B", "31C", "32A", "32B", "32C"], "TT99.30 + TT99.40"],
  ["51", "16. Chi phí thuế TNDN hiện hành", ["51"], "TT200.51 -> TT99.51"],
  ["52", "17. Chi phí thuế TNDN hoãn lại", ["52"], "TT200.52 -> TT99.52"],
  ["60", "18. Lợi nhuận sau thuế thu nhập doanh nghiệp (60 = 50 - 51 - 52)", ["01", "04", "05", "06", "11", "21", "22", "25", "26", "31A", "31B", "31C", "32A", "32B", "32C", "51", "52"], "TT99.50 - TT99.51 - TT99.52"],
  ["70", "19. Lãi cơ bản trên cổ phiếu (*)", [], "Monthly TT200 report does not provide auditable TT99 EPS inputs", "unavailable"],
  ["71", "20. Lãi suy giảm trên cổ phiếu (*)", [], "Monthly TT200 report does not provide auditable TT99 diluted EPS inputs", "unavailable"],
];

function requireAmount(source, code) {
  const row = source.get(code);
  if (!row || !Number.isFinite(row.amount)) throw new Error(`Missing numeric TT200 line ${code}`);
  return row.amount;
}

function convertTt200Month(source) {
  const value = (code) => requireAmount(source, code);
  const calculated = new Map();
  calculated.set("01", value("01"));
  calculated.set("02", value("04") + value("05") + value("06"));
  calculated.set("10", calculated.get("01") - calculated.get("02"));
  calculated.set("11", value("11"));
  calculated.set("20", calculated.get("10") - calculated.get("11"));
  calculated.set("22", value("21"));
  calculated.set("23", value("22"));
  calculated.set("24", value("23"));
  calculated.set("25", value("25"));
  calculated.set("26", value("26"));
  calculated.set("30", calculated.get("20") + calculated.get("22") - calculated.get("23") - calculated.get("25") - calculated.get("26"));
  calculated.set("31", value("31A") - value("31B") + value("31C"));
  calculated.set("32", value("32A") - value("32B") + value("32C"));
  calculated.set("40", calculated.get("31") - calculated.get("32"));
  calculated.set("50", calculated.get("30") + calculated.get("40"));
  calculated.set("51", value("51"));
  calculated.set("52", value("52"));
  calculated.set("60", calculated.get("50") - calculated.get("51") - calculated.get("52"));

  return B02_TT99_TARGETS.map(([code, label, sourceCodes, mappingRule, forcedStatus]) => ({
    targetLineCode: code,
    targetLineName: label,
    amount: forcedStatus === "unavailable" ? null : calculated.get(code),
    valueStatus: forcedStatus || "available",
    sourceLineCodes: sourceCodes,
    sourceCells: sourceCodes.map((sourceCode) => source.get(sourceCode)?.cell).filter(Boolean),
    mappingRule,
  }));
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new Error(`Invalid date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthsInClosedRange(startDate, endDate) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (start.day !== 1 || end.day !== daysInMonth(end.year, end.month)) return null;
  const startIndex = start.year * 12 + start.month - 1;
  const endIndex = end.year * 12 + end.month - 1;
  if (endIndex < startIndex) throw new Error("Historical B02 range end precedes start");
  const months = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    months.push({ fiscalYear: Math.floor(index / 12), fiscalMonth: index % 12 + 1 });
  }
  return months;
}

async function queryHistoricalB02Prior(client, startDate, endDate) {
  const expectedMonths = monthsInClosedRange(startDate, endDate);
  if (!expectedMonths?.length) return { applicable: false, reason: "partial-month-range", values: new Map(), monthCount: 0 };
  const first = expectedMonths[0];
  const last = expectedMonths[expectedMonths.length - 1];
  let result;
  try {
    result = await client.query(
      `select target_line_code,
              count(*)::int as row_count,
              count(*) filter (where value_status = 'available' and amount is not null)::int as available_count,
              sum(amount)::text as amount
         from public.b02_historical_monthly_values
        where (fiscal_year, fiscal_month) >= ($1::smallint, $2::smallint)
          and (fiscal_year, fiscal_month) <= ($3::smallint, $4::smallint)
        group by target_line_code`,
      [first.fiscalYear, first.fiscalMonth, last.fiscalYear, last.fiscalMonth],
    );
  } catch (error) {
    if (error?.code === "42P01") return { applicable: false, reason: "table-missing", values: new Map(), monthCount: 0 };
    throw error;
  }

  const values = new Map();
  for (const row of result.rows) {
    if (Number(row.row_count) !== expectedMonths.length) continue;
    values.set(row.target_line_code, Number(row.available_count) === expectedMonths.length ? Number(row.amount) : null);
  }
  return {
    applicable: values.size === B02_TT99_TARGETS.length,
    reason: values.size === B02_TT99_TARGETS.length ? "complete" : result.rows.length ? "incomplete" : "not-found",
    values,
    monthCount: expectedMonths.length,
  };
}

function applyHistoricalB02Prior(reportRows, history) {
  if (!history?.applicable) return reportRows;
  return reportRows.map((row) => history.values.has(row.code) ? { ...row, prior: history.values.get(row.code) } : row);
}

module.exports = {
  B02_TT99_TARGETS,
  applyHistoricalB02Prior,
  convertTt200Month,
  monthsInClosedRange,
  queryHistoricalB02Prior,
};
