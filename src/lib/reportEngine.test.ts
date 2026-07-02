import { generateReports } from "./reports";
import type { LedgerRow, PeriodRole } from "../types/finance";

function row(entry: string, account: string, debit: number, credit: number, periodRole: PeriodRole = "current"): LedgerRow {
  return {
    id: `${periodRole}-${entry}-${account}-${debit}-${credit}`,
    bucket: periodRole === "prior" || periodRole === "priorBalance" ? "prior" : "current",
    periodRole,
    fileName: "fixture",
    rowNumber: 1,
    journalId: entry,
    entryGroupKey: entry,
    postingDate: "2026-03-31",
    status: "Posted",
    accountCode: account,
    accountName: account,
    accountType: "",
    rootAccountCode: account.slice(0, 3),
    rootAccountName: "",
    journalName: "",
    journalNum: entry,
    sourceNum: "",
    department: "",
    accountAnalytic: "",
    debit,
    credit,
    balance: debit - credit,
    oppositeAccounts: [],
    raw: {},
  };
}

function value(code: string, rows: ReturnType<typeof generateReports>["B03"]) {
  return rows.find((reportRow) => reportRow.code === code)?.current ?? 0;
}

function assertEqual(actual: number, expected: number, label: string) {
  if (Math.round(actual) !== Math.round(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const fixtureRows: LedgerRow[] = [
  row("cash-from-ar", "112", 100, 0),
  row("cash-from-ar", "131", 0, 100),
  row("cash-from-revenue", "112", 108, 0),
  row("cash-from-revenue", "511", 0, 100),
  row("cash-from-revenue", "33311", 0, 8),
  row("supplier-payment", "331", 50, 0),
  row("supplier-payment", "112", 0, 50),
  row("admin-service-payment", "642", 30, 0),
  row("admin-service-payment", "112", 0, 30),
  row("salary-payment", "334", 20, 0),
  row("salary-payment", "112", 0, 20),
  row("other-receipt", "112", 15, 0),
  row("other-receipt", "141", 0, 15),
  row("other-payment", "338", 12, 0),
  row("other-payment", "112", 0, 12),
  row("ar-refund", "131", 5, 0),
  row("ar-refund", "112", 0, 5),
  row("advance-payment", "141", 7, 0),
  row("advance-payment", "112", 0, 7),
  row("other-payable-receipt", "112", 9, 0),
  row("other-payable-receipt", "338", 0, 9),
  row("loan-principal-payment", "341", 11, 0),
  row("loan-principal-payment", "112", 0, 11),
  row("balance-cash", "112", 197, 0, "currentBalance"),
  row("balance-capital", "411", 0, 151, "currentBalance"),
  row("cogs-period", "632", 40, 0),
];

const reports = generateReports(fixtureRows);
const b01ProvisionReports = generateReports([
  row("cash", "112", 100, 0, "currentBalance"),
  row("capital", "411", 0, 100, "currentBalance"),
  row("provision-2291", "2291", 0, 3, "currentBalance"),
  row("provision-2292", "2292", 0, 5, "currentBalance"),
]);
const b02SpecificReports = generateReports([
  row("investment-property-sale", "5117", 0, 100),
  row("investment-property-cost", "6327", 70, 0),
  row("interest-expense-a", "635411", 10, 0),
  row("interest-expense-b", "635412", 11, 0),
  row("interest-expense-c", "635413", 12, 0),
  row("other-finance-expense", "635999", 99, 0),
]);
const draftRevenue = row("draft-revenue", "511", 0, 500);
draftRevenue.status = "Draft";
const missingStatusRevenue = row("missing-status-revenue", "511", 0, 700);
missingStatusRevenue.status = "";
const postedOnlyReports = generateReports([
  draftRevenue,
  missingStatusRevenue,
  row("posted-revenue", "511", 0, 100),
]);

assertEqual(value("01", reports.B03), 203, "B03.01 includes cash in from 131/511/33311 and cash out reducing 131");
assertEqual(value("02", reports.B03), -80, "B03.02 supplier and service/admin expense payment");
assertEqual(value("03", reports.B03), -20, "B03.03 salary payment");
assertEqual(value("06", reports.B03), 17, "B03.06 other operating receipt/payment for 141, 331, 338, 711");
assertEqual(value("07", reports.B03), -12, "B03.07 other operating payment to 333 except 3334, 138, 244, 338");
assertEqual(value("34", reports.B03), -11, "B03.34 loan principal payment from 341");
assertEqual(value("20", reports.B03), 108, "B03.20 operating cash flow");
assertEqual(value("70", reports.B03), 197, "B03.70 ending cash matches B01 cash");
assertEqual(reports.B01.find((reportRow) => reportRow.code === "280")?.current ?? 0, 197, "B01 total assets");
assertEqual(reports.B01.find((reportRow) => reportRow.code === "420")?.current ?? 0, 46, "B01 retained earnings includes unclosed profit");
assertEqual(reports.B01.find((reportRow) => reportRow.code === "440")?.current ?? 0, 197, "B01 total liabilities and equity includes unclosed profit");
assertEqual(reports.B02.find((reportRow) => reportRow.code === "20")?.current ?? 0, 60, "B02 gross profit");
assertEqual(b01ProvisionReports.B01.find((reportRow) => reportRow.code === "124")?.current ?? 0, -3, "B01.124 uses only 2291");
assertEqual(b01ProvisionReports.B01.find((reportRow) => reportRow.code === "126")?.current ?? 0, -5, "B01.126 uses only 2292");
assertEqual(b01ProvisionReports.B01.find((reportRow) => reportRow.code === "266")?.current ?? 0, -5, "B01.266 uses only 2292");
assertEqual(b02SpecificReports.B02.find((reportRow) => reportRow.code === "21")?.current ?? 0, 30, "B02.21 nets 5117 credit less 6327 debit");
assertEqual(b02SpecificReports.B02.find((reportRow) => reportRow.code === "24")?.current ?? 0, 33, "B02.24 uses only 635411/635412/635413");
assertEqual(postedOnlyReports.B02.find((reportRow) => reportRow.code === "01")?.current ?? 0, 100, "Only status Posted is included");

console.log("report engine tests passed");
