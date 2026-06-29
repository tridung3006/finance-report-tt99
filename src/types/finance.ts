export type UploadBucket = "current" | "prior" | "opening";
export type PeriodRole = "current" | "prior" | "opening" | "currentBalance" | "priorBalance";

export type LedgerRow = {
  id: string;
  bucket: UploadBucket;
  periodRole?: PeriodRole;
  fileName: string;
  rowNumber: number;
  dbId?: number;
  journalId?: string;
  entryGroupKey?: string;
  postingDate: string;
  status: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  rootAccountCode: string;
  rootAccountName: string;
  journalName: string;
  journalNum: string;
  sourceNum: string;
  department: string;
  accountAnalytic: string;
  debit: number;
  credit: number;
  balance: number;
  oppositeAccounts?: string[];
  raw: Record<string, string>;
};

export type JournalEntry = {
  key: string;
  postingDate: string;
  journalId: string;
  journalNum: string;
  sourceNum: string;
  rows: LedgerRow[];
  debit: number;
  credit: number;
  balanced: boolean;
};

export type CashMovement = {
  entryKey: string;
  cashRow: LedgerRow;
  amount: number;
  direction: "in" | "out";
  oppositeRows: LedgerRow[];
  oppositeAccounts: string[];
  cashPeerCount?: number;
  matchedCode?: string;
  reason?: string;
};

export type PeriodMeta = {
  companyName: string;
  address: string;
  taxCode: string;
  year: string;
  startDate: string;
  endDate: string;
  currency: string;
  preparedDate: string;
};

export type ReportId = "B01" | "B02" | "B03" | "B09";

export type ReportRow = {
  label: string;
  code: string;
  note?: string;
  current: number | null;
  prior: number | null;
  level: number;
  bold?: boolean;
  negative?: boolean;
  formula?: string;
  sourceRef?: string;
  requiresManualMapping?: boolean;
  sourceAccounts?: string[];
  sources?: LedgerRow[];
};

export type ValidationIssue = {
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  rows?: LedgerRow[];
};

export type GeneratedReports = {
  B01: ReportRow[];
  B02: ReportRow[];
  B03: ReportRow[];
  B09: NoteSection[];
  validations: ValidationIssue[];
  unclassifiedCashRows: LedgerRow[];
  cashMovements: CashMovement[];
};

export type NoteSection = {
  title: string;
  paragraphs?: string[];
  table?: {
    columns: string[];
    rows: Array<Array<string | number>>;
  };
};

export type CashFlowRule = {
  code: string;
  direction: "in" | "out";
  oppositeAccountPrefixes?: string[];
  excludeAccountPrefixes?: string[];
  textIncludes?: string[];
  sourceRef?: string;
};

export type LineRule = {
  code: string;
  label: string;
  level: number;
  note?: string;
  bold?: boolean;
  negative?: boolean;
  accountPrefixes?: string[];
  expression?: string;
  side?: "debit" | "credit" | "balance";
  normalSide?: "debit" | "credit";
  sign?: 1 | -1;
  sourceRef?: string;
  requiresManualMapping?: boolean;
};
