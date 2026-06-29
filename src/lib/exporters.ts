import { saveAs } from "file-saver";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import type { PayableAgingResponse, RawSourceRow, TrialBalanceResponse } from "./api";
import type { GeneratedReports, LedgerRow, NoteSection, PeriodMeta, ReportId, ReportRow } from "../types/finance";
import { formatMoney, toPlainNumber } from "./format";

const FONT = "Arial";

type ProblemCashRow = {
  journalId: number | string;
  journalNum: string;
  postingDate: string;
  accountCode: string;
  accountName: string;
  amount: number;
  oppositeAccounts: string[];
  sourceNum: string;
  matchedCode?: string;
  reason?: string;
};

const reportNames: Record<Exclude<ReportId, "B09">, string> = {
  B01: "BÁO CÁO TÌNH HÌNH TÀI CHÍNH",
  B02: "BÁO CÁO KẾT QUẢ HOẠT ĐỘNG KINH DOANH",
  B03: "BÁO CÁO LƯU CHUYỂN TIỀN TỆ",
};

function aoaForReport(rows: ReportRow[], firstColumn: string, currentLabel: string, priorLabel: string) {
  return [
    [firstColumn, "Mã số", "Thuyết minh", currentLabel, priorLabel, "Công thức", "Cần mapping thủ công"],
    ...rows.map((row) => [
      row.label,
      row.code,
      row.note ?? "",
      toPlainNumber(row.current),
      toPlainNumber(row.prior),
      row.formula ?? "",
      row.requiresManualMapping ? "Có" : "",
    ]),
  ];
}

export function exportExcel(reports: GeneratedReports, ledger: LedgerRow[], meta: PeriodMeta) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Đơn vị báo cáo", meta.companyName],
      ["Địa chỉ", meta.address],
      ["MST", meta.taxCode],
      ["Kỳ", `${meta.startDate} - ${meta.endDate}`],
      ["Thông tư", "99/2025/TT-BTC"],
    ]),
    "Input Summary",
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reports.validations.map(({ severity, title, detail }) => ({ severity, title, detail }))), "Validation");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaForReport(reports.B01, "TÀI SẢN / NGUỒN VỐN", "Số cuối năm", "Số đầu năm")), "B01");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaForReport(reports.B02, "CHỈ TIÊU", "Năm nay", "Năm trước")), "B02");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaForReport(reports.B03, "Chỉ tiêu", "Năm nay", "Năm trước")), "B03");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notesToAoa(reports.B09)), "B09");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reports.unclassifiedCashRows.map(rowToObject)), "Unclassified");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reports.cashMovements.map(movementToObject)), "Cash QA");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledger.slice(0, 5000).map(rowToObject)), "Source Rows");
  XLSX.writeFile(wb, `BCTC-TT99-${meta.year || "report"}.xlsx`);
}

export function exportProblemWorkbook(params: {
  meta: PeriodMeta;
  validations: GeneratedReports["validations"];
  unclassifiedSummary: Array<{ reason: string; count: number; total: number }>;
  unclassifiedCashRows: ProblemCashRow[];
}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      params.validations.map((issue) => ({
        severity: issue.severity,
        title: issue.title,
        detail: issue.detail,
      })),
    ),
    "Validation Issues",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      params.unclassifiedSummary.map((row) => ({
        reason: row.reason,
        count: row.count,
        total: row.total,
      })),
    ),
    "Issue Summary",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      params.unclassifiedCashRows.map((row) => ({
        issue_type: "B03_UNCLASSIFIED_CASH_FLOW",
        reason: row.reason || "No B03 rule matched",
        posting_date: String(row.postingDate || "").slice(0, 10),
        journal_id: row.journalId,
        journal_num: row.journalNum,
        cash_account: row.accountCode,
        cash_account_name: row.accountName,
        amount: row.amount,
        opposite_accounts: row.oppositeAccounts?.join(", ") || "",
        source_num: row.sourceNum,
        suggested_action: "Rà soát tài khoản đối ứng/nội dung và cập nhật rule mapping B03 hoặc phân loại thủ công.",
      })),
    ),
    "B03 Unclassified",
  );
  XLSX.writeFile(wb, `BCTC-TT99-issues-${params.meta.startDate || "from"}-${params.meta.endDate || "to"}.xlsx`);
}

export function exportTrialBalanceWorkbook(report: TrialBalanceResponse) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["BẢNG CÂN ĐỐI PHÁT SINH"],
      ["Từ ngày", report.period.startDate],
      ["Đến ngày", report.period.endDate],
      ["Ngày tính dư đầu kỳ", report.period.openingDate],
      ["Tài khoản", report.filters.accountPrefix || "Tất cả"],
      ["Đối tượng (account_analytic)", report.filters.analytic || "Tất cả"],
      ["Breakdown theo đối tượng", report.filters.groupByAnalytic ? "Có" : "Không"],
      [],
      ["Root account", "Root account name", "Account", "Account name", "Đối tượng (account_analytic)", "Dư đầu Nợ", "Dư đầu Có", "Phát sinh Nợ", "Phát sinh Có", "Dư cuối Nợ", "Dư cuối Có", "Số dòng"],
      ...report.rows.map((row) => [
        row.rootAccountCode,
        row.rootAccountName,
        row.accountCode,
        row.accountName,
        row.accountAnalytic,
        row.openingDebit,
        row.openingCredit,
        row.periodDebit,
        row.periodCredit,
        row.closingDebit,
        row.closingCredit,
        row.rowCount,
      ]),
      ["", "", "", "Tổng", "", report.totals.openingDebit, report.totals.openingCredit, report.totals.periodDebit, report.totals.periodCredit, report.totals.closingDebit, report.totals.closingCredit, ""],
    ]),
    "Can doi phat sinh",
  );
  XLSX.writeFile(wb, `Can-doi-phat-sinh-${report.period.startDate}-${report.period.endDate}.xlsx`);
}

export function exportPayableAgingWorkbook(report: PayableAgingResponse) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["BAO CAO TUOI NO PHAI TRA NHA CUNG CAP"],
      ["Tai khoan", "331"],
      ["Den ngay", report.period.endDate],
      ["Loc doi tuong", report.filters.analytic || "Tat ca"],
      ["So dong journal", report.controls.journalRows],
      [],
      ["Ten doi tac", "Tong no", "No", "0-30 ngay", "31-60 ngay", "61-90 ngay", "91-120 ngay", "Tren 120 ngay", "So dong"],
      ...report.rows.map((row) => [
        row.accountAnalytic,
        row.totalDebt,
        row.debt,
        row.age0To30,
        row.age31To60,
        row.age61To90,
        row.age91To120,
        row.ageOver120,
        row.rowCount,
      ]),
      [
        "Tong cong",
        report.totals.totalDebt,
        report.totals.debt,
        report.totals.age0To30,
        report.totals.age31To60,
        report.totals.age61To90,
        report.totals.age91To120,
        report.totals.ageOver120,
        "",
      ],
    ]),
    "Tuoi no phai tra",
  );
  XLSX.writeFile(wb, `Tuoi-no-phai-tra-331-${report.period.endDate}.xlsx`);
}

export function exportRawSourceWorkbook(params: {
  report: string;
  code: string;
  label: string;
  side: "current" | "prior";
  total: number;
  meta: Record<string, unknown>;
  rows: RawSourceRow[];
}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Report", params.report],
      ["Code", params.code],
      ["Line", params.label],
      ["Side", params.side],
      ["Total rows", params.total],
      ["Source mode", String(params.meta.sourceMode || "")],
      ["From date", String(params.meta.fromDate || "")],
      ["To date", String(params.meta.toDate || "")],
      ["Prefixes", Array.isArray(params.meta.prefixes) ? params.meta.prefixes.join(", ") : ""],
      ["Matched B03 codes", Array.isArray(params.meta.matchedCodes) ? params.meta.matchedCodes.join(", ") : ""],
    ]),
    "Metadata",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      params.rows.map((row) => ({
        id: row.id ?? "",
        journal_id: row.journalId ?? "",
        journal_num: row.journalNum ?? "",
        posting_date: String(row.postingDate || "").slice(0, 10),
        status: row.status ?? "",
        account_code: row.accountCode ?? "",
        account_name: row.accountName ?? "",
        root_account_code: row.rootAccountCode ?? "",
        root_account_name: row.rootAccountName ?? "",
        debit: row.debit ?? "",
        credit: row.credit ?? "",
        balance: row.balance ?? "",
        amount: row.amount ?? "",
        account_analytic: row.accountAnalytic ?? "",
        department: row.department ?? "",
        opposite_accounts: row.oppositeAccounts?.join(", ") || "",
        matched_code: row.matchedCode ?? "",
        reason: row.reason ?? "",
        journal_name: row.journalName ?? "",
        source_num: row.sourceNum ?? "",
      })),
    ),
    "Raw source",
  );
  XLSX.writeFile(wb, `Raw-source-${params.report}-${params.code || "line"}-${params.side}.xlsx`);
}

function rowToObject(row: LedgerRow) {
  return {
    file: row.fileName,
    role: row.periodRole,
    row: row.rowNumber,
    journal_id: row.journalId,
    group: row.entryGroupKey,
    posting_date: row.postingDate,
    account_code: row.accountCode,
    account_name: row.accountName,
    debit: row.debit,
    credit: row.credit,
    balance: row.balance,
    opposite_accounts: row.oppositeAccounts?.join(", ") ?? "",
    journal: row.journalName,
    source: row.sourceNum,
  };
}

function movementToObject(movement: GeneratedReports["cashMovements"][number]) {
  return {
    code: movement.matchedCode ?? "Unclassified",
    reason: movement.reason ?? "",
    direction: movement.direction,
    amount: movement.amount,
    cash_account: movement.cashRow.accountCode,
    opposite_accounts: movement.oppositeAccounts.join(", "),
    journal_id: movement.cashRow.journalId,
    source: movement.cashRow.sourceNum,
  };
}

function notesToAoa(notes: NoteSection[]) {
  const output: Array<Array<string | number>> = [];
  notes.forEach((section) => {
    output.push([section.title]);
    section.paragraphs?.forEach((paragraph) => output.push([paragraph]));
    if (section.table) {
      output.push(section.table.columns);
      section.table.rows.forEach((row) => output.push(row));
    }
    output.push([]);
  });
  return output;
}

function p(text: string, bold = false, size = 22) {
  return new Paragraph({
    children: [new TextRun({ text, bold, size, font: FONT })],
    spacing: { after: 120 },
  });
}

function reportTable(rows: ReportRow[], firstColumn: string, currentLabel: string, priorLabel: string) {
  const header = new TableRow({
    children: [firstColumn, "Mã số", "Thuyết minh", currentLabel, priorLabel].map((text) => cell(text, true)),
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      header,
      ...rows.map((row) =>
        new TableRow({
          children: [
            cell(`${"  ".repeat(row.level)}${row.label}`, row.bold),
            cell(row.code, row.bold),
            cell(row.requiresManualMapping ? "Cần mapping" : row.note ?? "", row.bold),
            cell(formatMoney(row.current), row.bold),
            cell(formatMoney(row.prior), row.bold),
          ],
        }),
      ),
    ],
  });
}

function cell(text: string, bold = false) {
  return new TableCell({
    width: { size: 20, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18, font: FONT })] })],
  });
}

function signatureTable() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ["NGƯỜI LẬP", "KẾ TOÁN TRƯỞNG", "NGƯỜI ĐẠI DIỆN THEO PHÁP LUẬT"].map((text) => cell(text, true)) }),
      new TableRow({ children: ["(Ký, họ tên)", "(Ký, họ tên)", "(Ký, họ tên, đóng dấu)"].map((text) => cell(text)) }),
    ],
  });
}

export async function exportDocx(reports: GeneratedReports, meta: PeriodMeta) {
  const children = [
    p(`Đơn vị báo cáo: ${meta.companyName || "..."}`),
    p(`Địa chỉ: ${meta.address || "..."}`),
    p("Mẫu số B 01 - DN (Kèm theo Thông tư số 99/2025/TT-BTC ngày 27 tháng 10 năm 2025 của Bộ trưởng Bộ Tài chính)", true, 18),
    p("BÁO CÁO TÌNH HÌNH TÀI CHÍNH", true, 28),
    p(`Tại ngày ${meta.endDate || "..."} - Đơn vị tính: ${meta.currency || "VND"}`),
    reportTable(reports.B01, "TÀI SẢN / NGUỒN VỐN", "Số cuối năm", "Số đầu năm"),
    p("Mẫu số B 02 - DN", true, 18),
    p("BÁO CÁO KẾT QUẢ HOẠT ĐỘNG KINH DOANH", true, 28),
    p(`Kỳ kế toán từ ngày ${meta.startDate || "..."} đến ngày ${meta.endDate || "..."}`),
    reportTable(reports.B02, "CHỈ TIÊU", "Năm nay", "Năm trước"),
    p("Mẫu số B 03 - DN", true, 18),
    p("BÁO CÁO LƯU CHUYỂN TIỀN TỆ", true, 28),
    p("(Theo phương pháp trực tiếp)"),
    reportTable(reports.B03, "Chỉ tiêu", "Năm nay", "Năm trước"),
    p("Mẫu số B 09 - DN", true, 18),
    p("BẢN THUYẾT MINH BÁO CÁO TÀI CHÍNH", true, 28),
    ...reports.B09.flatMap((section) => noteSectionToDocx(section)),
    p(`Phê duyệt, ngày ${meta.preparedDate || "..."} `),
    signatureTable(),
  ];
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, `BCTC-TT99-${meta.year || "report"}.docx`);
}

function noteSectionToDocx(section: NoteSection) {
  const children: Array<Paragraph | Table> = [p(section.title, true, 24)];
  section.paragraphs?.forEach((paragraph) => children.push(p(paragraph)));
  if (section.table) {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: section.table.columns.map((col) => cell(col, true)) }),
          ...section.table.rows.map((row) => new TableRow({ children: row.map((value) => cell(typeof value === "number" ? formatMoney(value) : String(value))) })),
        ],
      }),
    );
  }
  return children;
}

async function loadArial(doc: jsPDF) {
  const response = await fetch("/api/fonts/arial.ttf");
  if (!response.ok) return false;
  const buffer = await response.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  doc.addFileToVFS("arial.ttf", btoa(binary));
  doc.addFont("arial.ttf", "Arial", "normal");
  doc.setFont("Arial", "normal");
  return true;
}

export async function exportPdf(reports: GeneratedReports, meta: PeriodMeta) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  await loadArial(doc);

  const addReport = (title: string, rows: ReportRow[], first: string, current: string, prior: string, newPage = true) => {
    if (newPage) doc.addPage();
    doc.setFont("Arial", "normal");
    doc.setFontSize(14);
    doc.text(title, 40, 36);
    doc.setFontSize(9);
    doc.text(`${meta.companyName || "Đơn vị báo cáo"} | ${meta.startDate || "..."} - ${meta.endDate || "..."}`, 40, 54);
    autoTable(doc, {
      startY: 70,
      head: [[first, "Mã số", "Thuyết minh", current, prior]],
      body: rows.map((row) => [`${"  ".repeat(row.level)}${row.label}`, row.code, row.requiresManualMapping ? "Cần mapping" : row.note ?? "", formatMoney(row.current), formatMoney(row.prior)]),
      styles: { font: "Arial", fontSize: 7, cellPadding: 3, fontStyle: "normal" },
      headStyles: { fillColor: [16, 97, 99], font: "Arial", fontStyle: "normal" },
      columnStyles: { 0: { cellWidth: 300 }, 3: { halign: "right" }, 4: { halign: "right" } },
    });
  };
  doc.setFont("Arial", "normal");
  doc.setFontSize(15);
  doc.text("BỘ BÁO CÁO TÀI CHÍNH THEO TT99", 40, 50);
  doc.text(meta.companyName || "Đơn vị báo cáo", 40, 74);
  addReport(reportNames.B01, reports.B01, "TÀI SẢN / NGUỒN VỐN", "Số cuối năm", "Số đầu năm");
  addReport(reportNames.B02, reports.B02, "CHỈ TIÊU", "Năm nay", "Năm trước");
  addReport(reportNames.B03, reports.B03, "Chỉ tiêu", "Năm nay", "Năm trước");
  doc.save(`BCTC-TT99-${meta.year || "report"}.pdf`);
}
