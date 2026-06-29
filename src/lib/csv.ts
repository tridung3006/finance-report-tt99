import type { LedgerRow, UploadBucket } from "../types/finance";

const aliases: Record<
  keyof Omit<LedgerRow, "id" | "bucket" | "periodRole" | "fileName" | "rowNumber" | "dbId" | "journalId" | "entryGroupKey" | "raw" | "debit" | "credit" | "balance" | "oppositeAccounts">,
  string[]
> = {
  postingDate: ["posting_date", "date", "ngay_hach_toan", "ngày hạch toán"],
  status: ["status", "trang_thai", "trạng thái"],
  accountCode: ["account_code", "account", "tk", "tai_khoan", "tài khoản"],
  accountName: ["account_name", "ten_tai_khoan", "tên tài khoản"],
  accountType: ["account_type", "loai_tai_khoan", "loại tài khoản"],
  rootAccountCode: ["root_account_code", "root_account", "tk_cap_1", "tài khoản cấp 1"],
  rootAccountName: ["root_account_name", "ten_tk_cap_1"],
  journalName: ["journal_name", "journal", "nhat_ky", "nhật ký"],
  journalNum: ["journal_num", "journal_number", "so_chung_tu", "số chứng từ"],
  sourceNum: ["source_num", "source", "dien_giai", "diễn giải", "description"],
  department: ["department", "bo_phan", "bộ phận"],
  accountAnalytic: ["account_analytic", "analytic", "kenh", "kênh"],
};

const numberAliases = {
  debit: ["debit", "no", "nợ", "phat_sinh_no", "ps_no"],
  credit: ["credit", "co", "có", "phat_sinh_co", "ps_co"],
  balance: ["balance", "so_du", "số dư"],
};

const excludedVirtualAccountNames = new Set(["more account 111/112", "more account 131"]);

function isVirtualAccountName(value: string) {
  return excludedVirtualAccountNames.has(value.trim().toLowerCase());
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

export function normalizeNumber(value: string | undefined): number {
  if (!value || value === "[NULL]") return 0;
  const cleaned = value.replace(/\((.*)\)/, "-$1").replace(/[,\s]/g, "").replace(/[^\d.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function findIndex(headers: string[], options: string[]) {
  const normalized = headers.map(normalizeKey);
  return options.map(normalizeKey).map((key) => normalized.indexOf(key)).find((idx) => idx >= 0) ?? -1;
}

export function detectColumns(headers: string[]) {
  const result: Record<string, number> = {};
  for (const [field, names] of Object.entries(aliases)) result[field] = findIndex(headers, names);
  for (const [field, names] of Object.entries(numberAliases)) result[field] = findIndex(headers, names);
  return result;
}

export async function fileToLedgerRows(file: File, bucket: UploadBucket): Promise<LedgerRow[]> {
  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  const columns = detectColumns(headers);

  return rows.slice(1).map((values, index) => {
    const raw = Object.fromEntries(headers.map((header, col) => [header, (values[col] ?? "").trim()]));
    const get = (field: string) => (columns[field] >= 0 ? (values[columns[field]] ?? "").trim() : "");
    const accountCode = get("accountCode").replace(/^'+/, "");
    const rootCode = get("rootAccountCode").replace(/^'+/, "");
    return {
      id: `${bucket}-${file.name}-${index}`,
      bucket,
      periodRole: bucket,
      fileName: file.name,
      rowNumber: index + 2,
      journalId: get("journalNum"),
      entryGroupKey: `${get("journalNum") || file.name}|${get("postingDate")}|${get("sourceNum")}`,
      postingDate: get("postingDate"),
      status: get("status"),
      accountCode,
      accountName: get("accountName"),
      accountType: get("accountType"),
      rootAccountCode: rootCode,
      rootAccountName: get("rootAccountName"),
      journalName: get("journalName"),
      journalNum: get("journalNum"),
      sourceNum: get("sourceNum"),
      department: get("department"),
      accountAnalytic: get("accountAnalytic"),
      debit: normalizeNumber(get("debit")),
      credit: normalizeNumber(get("credit")),
      balance: normalizeNumber(get("balance")),
      oppositeAccounts: [],
      raw,
    };
  }).filter((row) => !isVirtualAccountName(row.accountName));
}
