import type { GeneratedReports, ReportId, ValidationIssue } from "../types/finance";

export type AuthUser = { username: string };

export type GenerateReportsResponse = {
  formulaVersion: string;
  period: {
    startDate: string;
    endDate: string;
    priorStartDate: string;
    priorEndDate: string;
    openingBalanceDate?: string;
    currentYearStartDate?: string;
    currentB03OpeningDate?: string;
    priorB03OpeningDate?: string;
  };
  reports: Pick<GeneratedReports, "B01" | "B02" | "B03" | "B09">;
  validations: ValidationIssue[];
  counts: Record<string, number>;
  manualMapping: Array<{ reportCode: string; label: string }>;
  unclassifiedSummary: Array<{ reason: string; count: number; total: number }>;
};

export type DrilldownRow = {
  journalId: number | string;
  journalNum: string;
  postingDate: string;
  accountCode: string;
  accountName: string;
  amount: number;
  oppositeAccounts: string[];
  sourceNum: string;
  matchedCode: string;
  reason: string;
};

export type TrialBalanceRow = {
  rootAccountCode: string;
  rootAccountName: string;
  accountCode: string;
  accountName: string;
  accountAnalytic: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
  rowCount: number;
};

export type TrialBalanceResponse = {
  period: { startDate: string; endDate: string; openingDate: string };
  filters: { accountPrefix: string; analytic: string; groupByAnalytic: boolean };
  rows: TrialBalanceRow[];
  totals: Pick<
    TrialBalanceRow,
    "openingDebit" | "openingCredit" | "periodDebit" | "periodCredit" | "closingDebit" | "closingCredit"
  >;
};

export type PayableAgingBucket = "age0To30" | "age31To60" | "age61To90" | "age91To120" | "ageOver120";

export type PayableAgingRow = {
  accountAnalytic: string;
  accountAnalyticKey: string;
  totalDebt: number;
  debt: number;
  age0To30: number;
  age31To60: number;
  age61To90: number;
  age91To120: number;
  ageOver120: number;
  rowCount: number;
};

export type PayableAgingResponse = {
  period: { endDate: string; basis: string };
  filters: { accountPrefix: string; analytic: string };
  rows: PayableAgingRow[];
  totals: Pick<PayableAgingRow, "totalDebt" | "debt" | PayableAgingBucket>;
  controls: { journalRows: number; totalCreditBalance331: number };
};

export type RawSourceRow = {
  id?: number | string;
  journalId?: number | string;
  journalNum?: string;
  sourceNum?: string;
  journalName?: string;
  postingDate?: string;
  status?: string;
  accountCode?: string;
  accountName?: string;
  accountType?: string;
  rootAccountCode?: string;
  rootAccountName?: string;
  debit?: number;
  credit?: number;
  balance?: number;
  amount?: number;
  accountAnalytic?: string;
  department?: string;
  oppositeAccounts?: string[];
  matchedCode?: string;
  reason?: string;
};

export type RawSourceResponse = {
  rows: RawSourceRow[];
  total: number;
  page: number;
  pageSize: number;
  meta: Record<string, unknown>;
};

async function readJson<T = any>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Backend trả về dữ liệu không hợp lệ. Hãy kiểm tra server API ở port 3021.");
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ username, password }),
  });
  const body = await readJson<{ message?: string; user: AuthUser }>(response);
  if (!response.ok) throw new Error(body.message || "Đăng nhập thất bại");
  return body.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  const body = await readJson<{ user: AuthUser }>(response);
  if (!response.ok) return null;
  return body.user;
}

export async function generateServerReports(startDate: string, endDate: string): Promise<GenerateReportsResponse> {
  const response = await fetch("/api/reports/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ startDate, endDate }),
  });
  const body = await readJson<GenerateReportsResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không query được PostgreSQL");
  return body;
}

export async function fetchRawSource(params: {
  report: Exclude<ReportId, "B09">;
  code: string;
  startDate: string;
  endDate: string;
  side?: "current" | "prior";
  page: number;
  pageSize: number;
}): Promise<RawSourceResponse> {
  const query = new URLSearchParams({
    report: params.report,
    code: params.code,
    startDate: params.startDate,
    endDate: params.endDate,
    side: params.side || "current",
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  const response = await fetch(`/api/reports/raw-source?${query}`, { credentials: "same-origin" });
  const body = await readJson<RawSourceResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không tải được raw source");
  return body;
}

export async function fetchTrialBalance(params: {
  startDate: string;
  endDate: string;
  accountPrefix?: string;
  analytic?: string;
  groupByAnalytic?: boolean;
}): Promise<TrialBalanceResponse> {
  const response = await fetch("/api/reports/trial-balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(params),
  });
  const body = await readJson<TrialBalanceResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không tải được bảng cân đối phát sinh");
  return body;
}

export async function fetchTrialBalanceRawSource(params: {
  startDate: string;
  endDate: string;
  accountCode: string;
  accountAnalytic?: string;
  groupByAnalytic?: boolean;
  page: number;
  pageSize: number;
}): Promise<RawSourceResponse> {
  const response = await fetch("/api/reports/trial-balance/raw-source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(params),
  });
  const body = await readJson<RawSourceResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không tải được raw source cân đối phát sinh");
  return body;
}

export async function fetchPayableAging(params: {
  endDate: string;
  analytic?: string;
}): Promise<PayableAgingResponse> {
  const response = await fetch("/api/reports/payable-aging", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(params),
  });
  const body = await readJson<PayableAgingResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không tải được báo cáo tuổi nợ phải trả");
  return body;
}

export async function fetchPayableAgingRawSource(params: {
  endDate: string;
  accountAnalytic: string;
  accountAnalyticKey?: string;
  bucket?: PayableAgingBucket | "";
  page: number;
  pageSize: number;
}): Promise<RawSourceResponse> {
  const response = await fetch("/api/reports/payable-aging/raw-source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(params),
  });
  const body = await readJson<RawSourceResponse & { message?: string }>(response);
  if (!response.ok) throw new Error(body.message || "Không tải được raw source tuổi nợ phải trả");
  return body;
}

export async function fetchDrilldown(params: {
  report: ReportId;
  code: string;
  startDate: string;
  endDate: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: DrilldownRow[]; total: number; page: number; pageSize: number }> {
  const query = new URLSearchParams({
    report: params.report,
    code: params.code,
    startDate: params.startDate,
    endDate: params.endDate,
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  const response = await fetch(`/api/reports/drilldown?${query}`, { credentials: "same-origin" });
  const body = await readJson<{ rows: DrilldownRow[]; total: number; page: number; pageSize: number; message?: string }>(
    response,
  );
  if (!response.ok) throw new Error(body.message || "Không tải được drilldown");
  return body;
}
