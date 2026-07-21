import { AlertCircle, CheckCircle2, Database, Download, FileSpreadsheet, FileText, LayoutDashboard, Map as MapIcon, RefreshCw, Users, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createManagedUser, createMissingSnapshots, fetchDrilldown, fetchManagedUsers, fetchPayableAging, fetchPayableAgingRawSource, fetchRawSource, fetchSnapshotStatus, fetchTrialBalance, fetchTrialBalanceRawSource, generateServerReports, getCurrentUser, login, logout, rebuildSnapshots, resetManagedUserPassword, updateManagedUser, type AuthUser, type DrilldownReconciliation, type DrilldownRow, type GenerateReportsResponse, type ManagedUser, type PayableAgingBucket, type PayableAgingResponse, type PayableAgingRow, type RawSourceRow, type SnapshotAdminStatus, type TrialBalanceResponse, type TrialBalanceRow } from "./lib/api";
import { exportDocx, exportOfficialExcel, exportPayableAgingWorkbook, exportPdf, exportProblemWorkbook, exportQaExcel, exportRawSourceWorkbook, exportTrialBalanceWorkbook } from "./lib/exporters";
import { formatMoney } from "./lib/format";
import { generateReports } from "./lib/reports";
import type { LedgerRow, NoteBlock, NoteSection, PeriodMeta, ReportId, ReportRow } from "./types/finance";

const nav = [
  { id: "data", label: "Data", icon: Database, adminOnly: false },
  { id: "mapping", label: "Mapping", icon: MapIcon, adminOnly: true },
  { id: "validation", label: "Validation", icon: CheckCircle2, adminOnly: true },
  { id: "reports", label: "Reports", icon: LayoutDashboard, adminOnly: false },
  { id: "trial", label: "CĐ phát sinh", icon: FileSpreadsheet, adminOnly: false },
  { id: "payableAging", label: "Tuổi nợ NCC", icon: FileSpreadsheet, adminOnly: false },
  { id: "accounts", label: "Tài khoản", icon: Users, adminOnly: true },
  { id: "snapshots", label: "Snapshot", icon: RefreshCw, adminOnly: true },
  { id: "export", label: "Export", icon: Download, adminOnly: false },
] as const;

function isAdminOnlySection(section: string) {
  return section === "mapping" || section === "validation" || section === "accounts" || section === "snapshots";
}

const defaultMeta: PeriodMeta = {
  companyName: "",
  address: "",
  taxCode: "",
  year: "2026",
  startDate: "2026-03-01",
  endDate: "2026-03-31",
  currency: "VND",
  preparedDate: "",
};

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [active, setActive] = useState<(typeof nav)[number]["id"]>("data");
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [reportTab, setReportTab] = useState<ReportId>("B03");
  const [selectedLine, setSelectedLine] = useState<ReportRow | null>(null);
  const [meta, setMeta] = useState<PeriodMeta>(defaultMeta);
  const [queryInfo, setQueryInfo] = useState("");
  const [serverResult, setServerResult] = useState<GenerateReportsResponse | null>(null);
  const [drilldownRows, setDrilldownRows] = useState<DrilldownRow[]>([]);
  const [drilldownTotal, setDrilldownTotal] = useState(0);
  const [drilldownReconciliation, setDrilldownReconciliation] = useState<DrilldownReconciliation | null>(null);
  const [drilldownPage, setDrilldownPage] = useState(1);
  const [drilldownLoading, setDrilldownLoading] = useState("");
  const [issueExporting, setIssueExporting] = useState("");
  const [rawExporting, setRawExporting] = useState("");
  const [trialBalance, setTrialBalance] = useState<TrialBalanceResponse | null>(null);
  const [trialAccountPrefix, setTrialAccountPrefix] = useState("");
  const [trialAnalytic, setTrialAnalytic] = useState("");
  const [trialGroupByAnalytic, setTrialGroupByAnalytic] = useState(true);
  const [payableAging, setPayableAging] = useState<PayableAgingResponse | null>(null);
  const [payableAnalytic, setPayableAnalytic] = useState("");
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotAdminStatus | null>(null);
  const [snapshotFromMonth, setSnapshotFromMonth] = useState("2025-12");
  const [snapshotLoading, setSnapshotLoading] = useState("");
  const [snapshotMessage, setSnapshotMessage] = useState("");
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [accountLoading, setAccountLoading] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [newAccount, setNewAccount] = useState({ username: "", password: "", role: "user" as "admin" | "user" });
  const [resetAccount, setResetAccount] = useState<ManagedUser | null>(null);
  const [currentAdminPassword, setCurrentAdminPassword] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const csvReports = useMemo(() => generateReports(rows), [rows]);
  const reports = serverResult
    ? { ...serverResult.reports, validations: serverResult.validations, unclassifiedCashRows: [], cashMovements: [] }
    : csvReports;

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (!cancelled) setAuthUser(user);
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(username: string, password: string) {
    const user = await login(username, password);
    setAuthUser(user);
    if (!user.isAdmin && isAdminOnlySection(active)) setActive("data");
  }

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setServerResult(null);
    setRows([]);
    setSelectedLine(null);
    setSnapshotStatus(null);
  }

  async function loadSnapshotStatus() {
    if (!authUser?.isAdmin) return;
    setSnapshotLoading("Đang tải trạng thái snapshot...");
    setSnapshotMessage("");
    try {
      const status = await fetchSnapshotStatus();
      setSnapshotStatus(status);
      if (status.missingFromMonth) setSnapshotFromMonth(status.missingFromMonth);
    } catch (err) {
      setSnapshotMessage(err instanceof Error ? err.message : "Không tải được trạng thái snapshot");
    } finally {
      setSnapshotLoading("");
    }
  }

  async function handleCreateMissingSnapshots() {
    setSnapshotLoading("Đang tạo các snapshot tháng còn thiếu...");
    setSnapshotMessage("");
    try {
      const result = await createMissingSnapshots();
      setSnapshotStatus(await fetchSnapshotStatus());
      const refreshed = result.created ? await queryPostgres() : true;
      setSnapshotMessage(result.created
        ? `Đã tạo đầy đủ snapshot tháng còn thiếu. ${refreshed ? "Báo cáo đã tự làm mới." : "Snapshot đã xong nhưng báo cáo chưa làm mới được."}`
        : "Không có tháng snapshot nào bị thiếu.");
    } catch (err) {
      setSnapshotMessage(err instanceof Error ? err.message : "Không tạo được snapshot");
    } finally {
      setSnapshotLoading("");
    }
  }

  async function handleRebuildSnapshots() {
    if (!snapshotFromMonth || !window.confirm(`Tính lại toàn bộ snapshot từ ${snapshotFromMonth} đến tháng đã hoàn tất gần nhất?`)) return;
    setSnapshotLoading(`Đang tính lại snapshot từ ${snapshotFromMonth}...`);
    setSnapshotMessage("");
    try {
      const result = await rebuildSnapshots(snapshotFromMonth);
      setSnapshotStatus(await fetchSnapshotStatus());
      const refreshed = await queryPostgres();
      setSnapshotMessage(`Đã tạo batch ${result.batchId}, tính lại ${result.months.length} tháng. ${refreshed ? "Báo cáo đã tự làm mới theo snapshot mới nhất." : "Snapshot đã xong nhưng báo cáo chưa làm mới được."}`);
    } catch (err) {
      setSnapshotMessage(err instanceof Error ? err.message : "Không tính lại được snapshot");
    } finally {
      setSnapshotLoading("");
    }
  }

  async function loadManagedUsers() {
    if (!authUser?.isAdmin) return;
    setAccountLoading("Đang tải danh sách tài khoản...");
    setAccountMessage("");
    try {
      setManagedUsers(await fetchManagedUsers());
    } catch (err) {
      setAccountMessage(err instanceof Error ? err.message : "Không tải được danh sách tài khoản");
    } finally {
      setAccountLoading("");
    }
  }

  async function handleCreateAccount(event: FormEvent) {
    event.preventDefault();
    setAccountLoading("Đang tạo tài khoản...");
    setAccountMessage("");
    try {
      await createManagedUser(newAccount);
      setNewAccount({ username: "", password: "", role: "user" });
      setManagedUsers(await fetchManagedUsers());
      setAccountMessage("Đã tạo tài khoản.");
    } catch (err) {
      setAccountMessage(err instanceof Error ? err.message : "Không tạo được tài khoản");
    } finally {
      setAccountLoading("");
    }
  }

  async function handleUpdateAccount(user: ManagedUser, changes: { role?: "admin" | "user"; isActive?: boolean }) {
    setAccountLoading(`Đang cập nhật ${user.username}...`);
    setAccountMessage("");
    try {
      await updateManagedUser(user.id, changes);
      setManagedUsers(await fetchManagedUsers());
      setAccountMessage(`Đã cập nhật ${user.username}.`);
    } catch (err) {
      setAccountMessage(err instanceof Error ? err.message : "Không cập nhật được tài khoản");
    } finally {
      setAccountLoading("");
    }
  }

  async function handleResetAccountPassword(event: FormEvent) {
    event.preventDefault();
    if (!resetAccount) return;
    setAccountLoading(`Đang đổi mật khẩu ${resetAccount.username}...`);
    setAccountMessage("");
    try {
      const result = await resetManagedUserPassword(resetAccount.id, currentAdminPassword, newAccountPassword);
      setCurrentAdminPassword("");
      setNewAccountPassword("");
      setResetAccount(null);
      if (result.logoutRequired) {
        setAuthUser(null);
        setManagedUsers([]);
        return;
      }
      setManagedUsers(await fetchManagedUsers());
      setAccountMessage(`Đã đổi mật khẩu ${resetAccount.username} và đăng xuất các phiên cũ của tài khoản này.`);
    } catch (err) {
      setAccountMessage(err instanceof Error ? err.message : "Không đổi được mật khẩu");
    } finally {
      setAccountLoading("");
    }
  }

  useEffect(() => {
    if (active === "snapshots" && authUser?.isAdmin) void loadSnapshotStatus();
  }, [active, authUser?.isAdmin]);

  useEffect(() => {
    if (active === "accounts" && authUser?.isAdmin) void loadManagedUsers();
  }, [active, authUser?.isAdmin]);

  useEffect(() => {
    if (authUser && !authUser.isAdmin && isAdminOnlySection(active)) setActive("data");
  }, [active, authUser]);

  async function queryPostgres(): Promise<boolean> {
    setError("");
    setLoading("Đang query PostgreSQL...");
    try {
      const result = await generateServerReports(meta.startDate, meta.endDate);
      setServerResult(result);
      setRows([]);
      setQueryInfo(
        `Backend aggregate ${result.counts.currentRows.toLocaleString("vi-VN")} dòng kỳ hiện tại, ${result.counts.priorRows.toLocaleString("vi-VN")} dòng kỳ trước. Payload compact, formula ${result.formulaVersion}.`,
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không query được PostgreSQL");
      return false;
    } finally {
      setLoading("");
    }
  }

  useEffect(() => {
    if (!serverResult || !selectedLine || reportTab === "B09" || !selectedLine.code) {
      setDrilldownRows([]);
      setDrilldownTotal(0);
      setDrilldownReconciliation(null);
      return;
    }
    let cancelled = false;
    setDrilldownLoading("Đang tải drilldown...");
    fetchDrilldown({
      report: reportTab,
      code: selectedLine.code,
      startDate: meta.startDate,
      endDate: meta.endDate,
      page: drilldownPage,
      pageSize: 100,
    })
      .then((data) => {
        if (cancelled) return;
        setDrilldownRows(data.rows);
        setDrilldownTotal(data.total);
        setDrilldownReconciliation(data.reconciliation);
      })
      .catch((err) => {
        if (!cancelled) setDrilldownLoading(err instanceof Error ? err.message : "Không tải được drilldown");
      })
      .finally(() => {
        if (!cancelled) setDrilldownLoading("");
      });
    return () => {
      cancelled = true;
    };
  }, [serverResult, selectedLine, reportTab, drilldownPage, meta.startDate, meta.endDate]);

  async function exportIssueRows() {
    setIssueExporting("Đang export các dòng cần xử lý...");
    setError("");
    try {
      if (serverResult) {
        const pageSize = 500;
        const firstPage = await fetchDrilldown({
          report: "B03",
          code: "",
          startDate: meta.startDate,
          endDate: meta.endDate,
          page: 1,
          pageSize,
        });
        const allRows = [...firstPage.rows];
        const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
        for (let page = 2; page <= pageCount; page += 1) {
          const nextPage = await fetchDrilldown({
            report: "B03",
            code: "",
            startDate: meta.startDate,
            endDate: meta.endDate,
            page,
            pageSize,
          });
          allRows.push(...nextPage.rows);
        }
        exportProblemWorkbook({
          meta,
          validations: serverResult.validations,
          unclassifiedSummary: serverResult.unclassifiedSummary,
          unclassifiedCashRows: allRows,
        });
      } else {
        exportProblemWorkbook({
          meta,
          validations: reports.validations,
          unclassifiedSummary: reports.unclassifiedCashRows.length
            ? [{ reason: "No B03 rule matched", count: reports.unclassifiedCashRows.length, total: reports.unclassifiedCashRows.reduce((sum, row) => sum + Math.abs(row.balance || row.debit - row.credit), 0) }]
            : [],
          unclassifiedCashRows: reports.unclassifiedCashRows.map((row) => ({
            journalId: row.journalId || row.journalNum || row.id,
            journalNum: row.journalNum,
            postingDate: row.postingDate,
            accountCode: row.accountCode,
            accountName: row.accountName,
            amount: Math.abs(row.debit - row.credit || row.balance),
            oppositeAccounts: row.oppositeAccounts || [],
            sourceNum: row.sourceNum,
            reason: "No B03 rule matched",
          })),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không export được file lỗi");
    } finally {
      setIssueExporting("");
    }
  }

  async function loadTrialBalance() {
    setError("");
    setLoading("Đang tải bảng cân đối phát sinh...");
    try {
      const result = await fetchTrialBalance({
        startDate: meta.startDate,
        endDate: meta.endDate,
        accountPrefix: trialAccountPrefix,
        analytic: trialAnalytic,
        groupByAnalytic: trialGroupByAnalytic,
      });
      setTrialBalance(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được bảng cân đối phát sinh");
    } finally {
      setLoading("");
    }
  }

  async function exportSelectedRawSource(side: "current" | "prior") {
    if (!serverResult || !selectedLine || reportTab === "B09" || !selectedLine.code) return;
    const pageSize = 1000;
    setRawExporting(`Đang export raw source ${reportTab}.${selectedLine.code}...`);
    setError("");
    try {
      const firstPage = await fetchRawSource({
        report: reportTab,
        code: selectedLine.code,
        startDate: meta.startDate,
        endDate: meta.endDate,
        side,
        page: 1,
        pageSize,
      });
      const rows: RawSourceRow[] = [...firstPage.rows];
      const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        setRawExporting(`Đang export raw source ${reportTab}.${selectedLine.code}: trang ${page}/${pageCount}...`);
        const nextPage = await fetchRawSource({
          report: reportTab,
          code: selectedLine.code,
          startDate: meta.startDate,
          endDate: meta.endDate,
          side,
          page,
          pageSize,
        });
        rows.push(...nextPage.rows);
      }
      exportRawSourceWorkbook({
        report: reportTab,
        code: selectedLine.code,
        label: selectedLine.label,
        side,
        total: firstPage.total,
        meta: firstPage.meta,
        rows,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không export được raw source");
    } finally {
      setRawExporting("");
    }
  }

  async function exportTrialRowRawSource(row: TrialBalanceRow) {
    const pageSize = 1000;
    setRawExporting(`Đang export raw source tài khoản ${row.accountCode}...`);
    setError("");
    try {
      const firstPage = await fetchTrialBalanceRawSource({
        startDate: meta.startDate,
        endDate: meta.endDate,
        accountCode: row.accountCode,
        accountAnalytic: row.accountAnalytic,
        analyticFilter: trialAnalytic,
        groupByAnalytic: trialGroupByAnalytic,
        page: 1,
        pageSize,
      });
      const rows: RawSourceRow[] = [...firstPage.rows];
      const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        setRawExporting(`Đang export raw source tài khoản ${row.accountCode}: trang ${page}/${pageCount}...`);
        const nextPage = await fetchTrialBalanceRawSource({
          startDate: meta.startDate,
          endDate: meta.endDate,
          accountCode: row.accountCode,
          accountAnalytic: row.accountAnalytic,
          analyticFilter: trialAnalytic,
          groupByAnalytic: trialGroupByAnalytic,
          page,
          pageSize,
        });
        rows.push(...nextPage.rows);
      }
      exportRawSourceWorkbook({
        report: "CĐ phát sinh",
        code: row.accountCode,
        label: row.accountAnalytic || row.accountName,
        side: "current",
        total: firstPage.total,
        meta: firstPage.meta,
        rows,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không export được raw source cân đối phát sinh");
    } finally {
      setRawExporting("");
    }
  }

  async function loadPayableAging() {
    setError("");
    setLoading("Đang tải báo cáo tuổi nợ phải trả...");
    try {
      const result = await fetchPayableAging({
        endDate: meta.endDate,
        analytic: payableAnalytic,
      });
      setPayableAging(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được báo cáo tuổi nợ phải trả");
    } finally {
      setLoading("");
    }
  }

  async function exportPayableAgingRaw(row: PayableAgingRow, bucket: PayableAgingBucket | "") {
    const pageSize = 1000;
    const bucketLabel = bucket || "all";
    setRawExporting(`Đang export raw source tuổi nợ ${row.accountAnalytic}...`);
    setError("");
    try {
      const firstPage = await fetchPayableAgingRawSource({
        endDate: meta.endDate,
        accountAnalytic: row.accountAnalytic,
        accountAnalyticKey: row.accountAnalyticKey,
        bucket,
        page: 1,
        pageSize,
      });
      const rows: RawSourceRow[] = [...firstPage.rows];
      const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);
      for (let page = 2; page <= pageCount; page += 1) {
        setRawExporting(`Đang export raw source tuổi nợ ${row.accountAnalytic}: trang ${page}/${pageCount}...`);
        const nextPage = await fetchPayableAgingRawSource({
          endDate: meta.endDate,
          accountAnalytic: row.accountAnalytic,
          accountAnalyticKey: row.accountAnalyticKey,
          bucket,
          page,
          pageSize,
        });
        rows.push(...nextPage.rows);
      }
      exportRawSourceWorkbook({
        report: "Tuổi nợ phải trả 331",
        code: bucketLabel,
        label: row.accountAnalytic,
        side: "current",
        total: firstPage.total,
        meta: firstPage.meta,
        rows,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không export được raw source tuổi nợ phải trả");
    } finally {
      setRawExporting("");
    }
  }

  const currentReportRows = reportTab === "B09" ? [] : reports[reportTab];

  if (!authChecked) {
    return <div className="auth-shell"><div className="auth-card"><h1>BOO - BCTC TT99</h1><p>Đang kiểm tra phiên đăng nhập...</p></div></div>;
  }

  if (!authUser) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <WalletCards size={24} />
          <span>BOO - BCTC TT99</span>
        </div>
        {nav.filter((item) => !item.adminOnly || authUser.isAdmin).map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={active === item.id ? "nav active" : "nav"} onClick={() => setActive(item.id)} title={item.label}>
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </aside>

      <main>
        <header className="topbar">
          <div>
            <h1>BOO - BCTC TT99</h1>
          </div>
          <div className="top-actions">
            <div className="status-pill">{serverResult ? "server aggregate" : `${rows.length.toLocaleString("vi-VN")} dòng nguồn`}</div>
            <button className="logout-button" onClick={handleLogout}>Đăng xuất</button>
          </div>
        </header>

        {active === "data" && (
          <section className="grid two">
            <div className="panel">
              <h2>Nguồn dữ liệu PostgreSQL</h2>
              <div className="form-grid">
                <label>
                  <span>Từ ngày</span>
                  <input value={meta.startDate} onChange={(event) => setMeta((current) => ({ ...current, startDate: event.target.value }))} />
                </label>
                <label>
                  <span>Đến ngày</span>
                  <input value={meta.endDate} onChange={(event) => setMeta((current) => ({ ...current, endDate: event.target.value }))} />
                </label>
              </div>
              <button className="primary-action" onClick={queryPostgres} disabled={Boolean(loading)}>
                <Database size={18} /> Query journal
              </button>
              {loading && <p>{loading}</p>}
              {error && <div className="issue error"><AlertCircle size={18} /><div><strong>Lỗi</strong><p>{error}</p></div></div>}
              {queryInfo && <div className="issue info"><CheckCircle2 size={18} /><div><strong>Đã query</strong><p>{queryInfo}</p></div></div>}
            </div>
            <div className="panel">
              <h2>Preview dữ liệu</h2>
              {serverResult ? <CountsPreview result={serverResult} /> : <LedgerPreview rows={rows.slice(0, 40)} />}
            </div>
          </section>
        )}

        {active === "mapping" && authUser.isAdmin && (
          <section className="grid two">
            <div className="panel">
              <h2>Registry công thức TT99</h2>
              <div className="mapping-list">
                {[
                  ["B01", "Dùng số dư lũy kế đến ngày báo cáo; assert 280 = 440"],
                  ["B02", "Dùng phát sinh kỳ hiện tại/kỳ trước; assert 10, 20, 30, 40, 50, 60"],
                  ["B03", "Group theo journal_id; phân loại 111/112/113 theo tài khoản đối ứng"],
                  ["B03.01", "Inflow tiền đối ứng 511, 33311, 131, 121"],
                  ["B09", "Đúng 53 bảng nội dung theo mẫu B09-DN; dữ liệu không đủ nguồn được để trống/chưa nhập"],
                ].map(([name, rule]) => (
                  <div className="mapping-row" key={name}>
                    <strong>{name}</strong>
                    <span>{rule}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <h2>Tài khoản phát hiện</h2>
              <AccountSummary rows={rows} />
            </div>
          </section>
        )}

        {active === "validation" && authUser.isAdmin && (
          <section className="panel">
            <div className="section-head">
              <h2>Checklist kiểm tra trước khi xuất</h2>
              <button onClick={exportIssueRows} disabled={Boolean(issueExporting)}>
                <FileSpreadsheet size={16} /> Export lỗi XLSX
              </button>
            </div>
            <div className="issues">
              {reports.validations.map((issue) => (
                <div className={`issue ${issue.severity}`} key={`${issue.title}-${issue.detail}`}>
                  <AlertCircle size={18} />
                  <div>
                    <strong>{issue.title}</strong>
                    <p>{issue.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            {issueExporting && <p className="muted">{issueExporting}</p>}
            <h3>Dòng tiền cần phân loại</h3>
            {serverResult ? (
              <UnclassifiedServerSummary result={serverResult} onExport={exportIssueRows} exporting={issueExporting} />
            ) : (
              <LedgerPreview rows={reports.unclassifiedCashRows.slice(0, 80)} />
            )}
          </section>
        )}

        {active === "reports" && (
          <section className="reports-layout">
            <div className="panel">
              <div className="tabs">
                {(["B01", "B02", "B03", "B09"] as ReportId[]).map((tab) => (
                  <button key={tab} className={reportTab === tab ? "tab active" : "tab"} onClick={() => setReportTab(tab)}>
                    {tab}
                  </button>
                ))}
              </div>
              {reportTab === "B09" ? <NotesPreview reports={reports} /> : <ReportTable reportId={reportTab} rows={currentReportRows} onSelect={(row) => { setSelectedLine(row); setDrilldownPage(1); }} />}
            </div>
            <aside className="panel drilldown">
              <h2>Drilldown</h2>
              {selectedLine ? (
                <>
                  <strong>{selectedLine.code} - {selectedLine.label}</strong>
                  {serverResult && reportTab !== "B09" && selectedLine.code && (
                    <div className="inline-actions raw-actions">
                      <button onClick={() => exportSelectedRawSource("current")} disabled={Boolean(rawExporting)}>
                        <FileSpreadsheet size={16} /> Export raw hiện tại
                      </button>
                      <button onClick={() => exportSelectedRawSource("prior")} disabled={Boolean(rawExporting)}>
                        <FileSpreadsheet size={16} /> Export raw so sánh
                      </button>
                    </div>
                  )}
                  {rawExporting && <p className="muted">{rawExporting}</p>}
                  <p className="muted">{selectedLine.formula || "Không có công thức."}</p>
                  <p className="muted">Tài khoản nguồn: {selectedLine.sourceAccounts?.join(", ") || "N/A"}</p>
                  {serverResult ? (
                    <ServerDrilldown rows={drilldownRows} total={drilldownTotal} page={drilldownPage} loading={drilldownLoading} reconciliation={drilldownReconciliation} onPage={setDrilldownPage} />
                  ) : (
                    <LedgerPreview rows={(selectedLine.sources ?? []).slice(0, 20)} compact />
                  )}
                </>
              ) : (
                <p className="muted">Chọn một dòng báo cáo để xem bút toán nguồn.</p>
              )}
            </aside>
          </section>
        )}

        {active === "trial" && (
          <section className="panel">
            <div className="section-head">
              <div>
                <h2>Bảng cân đối phát sinh</h2>
              </div>
              <button onClick={() => trialBalance && exportTrialBalanceWorkbook(trialBalance)} disabled={!trialBalance}>
                <FileSpreadsheet size={16} /> Export XLSX
              </button>
            </div>
            <div className="form-grid trial-filters">
              <label>
                <span>Tài khoản / tiền tố tài khoản</span>
                <input value={trialAccountPrefix} placeholder="Ví dụ: 331" onChange={(event) => setTrialAccountPrefix(event.target.value)} />
              </label>
              <label>
                <span>Lọc đối tượng (account_analytic)</span>
                <input value={trialAnalytic} placeholder="Nhập tên đối tượng" onChange={(event) => setTrialAnalytic(event.target.value)} />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={trialGroupByAnalytic} onChange={(event) => setTrialGroupByAnalytic(event.target.checked)} />
                <span>Breakdown theo đối tượng account_analytic</span>
              </label>
              <div className="inline-actions align-end">
                <button className="primary-action" onClick={loadTrialBalance} disabled={Boolean(loading)}>
                  <Database size={18} /> Tạo báo cáo
                </button>
              </div>
            </div>
            {loading && <p>{loading}</p>}
            {error && <div className="issue error"><AlertCircle size={18} /><div><strong>Lỗi</strong><p>{error}</p></div></div>}
            {rawExporting && <p className="muted">{rawExporting}</p>}
            {trialBalance ? <TrialBalanceTable report={trialBalance} onExportRaw={exportTrialRowRawSource} exporting={Boolean(rawExporting)} /> : <div className="empty">Chọn kỳ, tài khoản hoặc account_analytic rồi tạo báo cáo.</div>}
          </section>
        )}

        {active === "payableAging" && (
          <section className="panel">
            <div className="section-head">
              <div>
                <h2>Phân tích công nợ phải trả theo tuổi nợ</h2>
              </div>
              <button onClick={() => payableAging && exportPayableAgingWorkbook(payableAging)} disabled={!payableAging}>
                <FileSpreadsheet size={16} /> Export XLSX
              </button>
            </div>
            <div className="form-grid trial-filters">
              <label>
                <span>Đến ngày</span>
                <input value={meta.endDate} onChange={(event) => setMeta((current) => ({ ...current, endDate: event.target.value }))} />
              </label>
              <label>
                <span>Lọc đối tượng (account_analytic)</span>
                <input value={payableAnalytic} placeholder="Nhập tên đối tác" onChange={(event) => setPayableAnalytic(event.target.value)} />
              </label>
              <div className="inline-actions align-end">
                <button className="primary-action" onClick={loadPayableAging} disabled={Boolean(loading)}>
                  <Database size={18} /> Tạo báo cáo
                </button>
              </div>
            </div>
            {loading && <p>{loading}</p>}
            {error && <div className="issue error"><AlertCircle size={18} /><div><strong>Lỗi</strong><p>{error}</p></div></div>}
            {rawExporting && <p className="muted">{rawExporting}</p>}
            {payableAging ? (
              <PayableAgingTable report={payableAging} onExportRaw={exportPayableAgingRaw} exporting={Boolean(rawExporting)} />
            ) : (
              <div className="empty">Chọn ngày báo cáo rồi tạo báo cáo tuổi nợ phải trả.</div>
            )}
          </section>
        )}

        {active === "accounts" && authUser.isAdmin && (
          <section className="grid two account-admin">
            <div className="panel wide">
              <div className="section-head">
                <h2>Quản lý tài khoản</h2>
                <button onClick={loadManagedUsers} disabled={Boolean(accountLoading)}><RefreshCw size={16} /> Làm mới</button>
              </div>
              {accountLoading && <p>{accountLoading}</p>}
              {accountMessage && <div className="issue info"><CheckCircle2 size={18} /><div><strong>Tài khoản</strong><p>{accountMessage}</p></div></div>}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Username</th><th>Role</th><th>Trạng thái</th><th>Đăng nhập cuối</th><th>Thao tác</th></tr></thead>
                  <tbody>
                    {managedUsers.map((user) => {
                      const isSelf = user.username === authUser.username;
                      return (
                        <tr key={user.id}>
                          <td><strong>{user.username}</strong>{isSelf && <span className="self-badge">Bạn</span>}</td>
                          <td>
                            <select value={user.role} disabled={isSelf || Boolean(accountLoading)} onChange={(event) => handleUpdateAccount(user, { role: event.target.value as "admin" | "user" })}>
                              <option value="user">User</option>
                              <option value="admin">Admin</option>
                            </select>
                          </td>
                          <td>{user.isActive ? "Đang hoạt động" : "Đã khóa"}</td>
                          <td>{formatDateTime(user.lastLoginAt)}</td>
                          <td>
                            <div className="row-actions">
                              <button className="mini-button" onClick={() => setResetAccount(user)}>Đổi mật khẩu</button>
                              {!isSelf && <button className="mini-button" disabled={Boolean(accountLoading)} onClick={() => handleUpdateAccount(user, { isActive: !user.isActive })}>{user.isActive ? "Khóa" : "Mở khóa"}</button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <form className="panel" onSubmit={handleCreateAccount}>
              <h2>Tạo tài khoản</h2>
              <div className="form-grid one-column">
                <label><span>Username</span><input autoComplete="off" required minLength={3} maxLength={64} value={newAccount.username} onChange={(event) => setNewAccount((current) => ({ ...current, username: event.target.value }))} /></label>
                <label><span>Role</span><select value={newAccount.role} onChange={(event) => setNewAccount((current) => ({ ...current, role: event.target.value as "admin" | "user" }))}><option value="user">User</option><option value="admin">Admin</option></select></label>
                <label><span>Mật khẩu ban đầu</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newAccount.password} onChange={(event) => setNewAccount((current) => ({ ...current, password: event.target.value }))} /></label>
              </div>
              <button className="primary-action" type="submit" disabled={Boolean(accountLoading)}>Tạo tài khoản</button>
            </form>

            <form className="panel" onSubmit={handleResetAccountPassword}>
              <h2>Đổi mật khẩu</h2>
              {resetAccount ? (
                <>
                  <p>Đang đổi mật khẩu cho <strong>{resetAccount.username}</strong>. Bạn cần xác nhận mật khẩu admin hiện tại.</p>
                  <div className="form-grid one-column">
                    <label><span>Mật khẩu admin hiện tại</span><input type="password" autoComplete="current-password" required value={currentAdminPassword} onChange={(event) => setCurrentAdminPassword(event.target.value)} /></label>
                    <label><span>Mật khẩu mới</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newAccountPassword} onChange={(event) => setNewAccountPassword(event.target.value)} /></label>
                  </div>
                  <div className="inline-actions account-password-actions">
                    <button type="button" onClick={() => { setResetAccount(null); setCurrentAdminPassword(""); setNewAccountPassword(""); }}>Hủy</button>
                    <button className="primary-action" type="submit" disabled={Boolean(accountLoading)}>Lưu mật khẩu mới</button>
                  </div>
                  {resetAccount.username === authUser.username && <p className="muted">Sau khi đổi mật khẩu của chính mình, bạn sẽ phải đăng nhập lại.</p>}
                </>
              ) : <div className="empty">Chọn “Đổi mật khẩu” tại một tài khoản.</div>}
            </form>
          </section>
        )}

        {active === "snapshots" && authUser.isAdmin && (
          <section className="grid two snapshot-admin">
            <div className="panel">
              <div className="section-head">
                <div>
                  <h2>Quản trị snapshot số dư</h2>
                  <p className="muted">Chỉ tài khoản admin nhìn thấy và gọi được chức năng này.</p>
                </div>
                <button onClick={loadSnapshotStatus} disabled={Boolean(snapshotLoading)}>
                  <RefreshCw size={16} /> Làm mới
                </button>
              </div>
              <div className="snapshot-summary">
                <div><span>Snapshot mới nhất</span><strong>{snapshotStatus?.latestSnapshot || "Chưa có"}</strong></div>
                <div><span>Tháng bắt đầu snapshot</span><strong>{snapshotStatus?.migrationMonth || "2025-12"}</strong></div>
                <div><span>Tháng đã hoàn tất</span><strong>{snapshotStatus?.lastClosedMonth || "—"}</strong></div>
                <div><span>Tháng đang thiếu</span><strong>{snapshotStatus?.missingFromMonth || "Không thiếu"}</strong></div>
                <div><span>Job tự động</span><strong>{snapshotStatus?.scheduler.enabled ? `${String(snapshotStatus.scheduler.scheduleHour).padStart(2, "0")}:00 ${snapshotStatus.scheduler.timeZone}` : "Đã tắt"}</strong></div>
              </div>
              <div className="inline-actions snapshot-actions">
                <button className="primary-action" onClick={handleCreateMissingSnapshots} disabled={Boolean(snapshotLoading)}>
                  <RefreshCw size={17} /> Tạo tháng còn thiếu
                </button>
              </div>
              <hr />
              <h3>Tính lại do Odoo sửa dữ liệu quá khứ</h3>
              <p className="muted">Hãy đồng bộ journal từ Odoo trước, sau đó chọn tháng sớm nhất bị ảnh hưởng.</p>
              <div className="form-grid trial-filters">
                <label>
                  <span>Tính lại từ tháng</span>
                  <input
                    type="month"
                    min={snapshotStatus?.migrationMonth || "2025-12"}
                    max={snapshotStatus?.lastClosedMonth || undefined}
                    value={snapshotFromMonth}
                    onChange={(event) => setSnapshotFromMonth(event.target.value)}
                  />
                </label>
                <div className="inline-actions align-end">
                  <button className="primary-action" onClick={handleRebuildSnapshots} disabled={Boolean(snapshotLoading) || !snapshotFromMonth}>
                    <RefreshCw size={17} /> Tính lại đến hiện tại
                  </button>
                </div>
              </div>
              {snapshotLoading && <p>{snapshotLoading}</p>}
              {snapshotMessage && <div className="issue info"><CheckCircle2 size={18} /><div><strong>Snapshot</strong><p>{snapshotMessage}</p></div></div>}
            </div>
            <div className="panel">
              <h2>Danh sách snapshot hiện hành</h2>
              <div className="table-wrap compact">
                <table>
                  <thead><tr><th>Ngày</th><th className="num">Dòng</th><th className="num">Lũy kế Nợ</th><th className="num">Lũy kế Có</th></tr></thead>
                  <tbody>
                    {(snapshotStatus?.months || []).map((month) => (
                      <tr key={month.snapshotDate}>
                        <td>{month.snapshotDate}</td>
                        <td className="num">{month.rowCount.toLocaleString("vi-VN")}</td>
                        <td className="num">{formatMoney(month.cumulativeDebit)}</td>
                        <td className="num">{formatMoney(month.cumulativeCredit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {active === "export" && (
          <section className="grid two">
            <div className="panel">
              <h2>Thông tin báo cáo</h2>
              <div className="form-grid">
                {Object.entries(meta).map(([key, value]) => (
                  <label key={key}>
                    <span>{metaLabel(key)}</span>
                    <input value={value} onChange={(event) => setMeta((current) => ({ ...current, [key]: event.target.value }))} />
                  </label>
                ))}
              </div>
            </div>
            <div className="panel export-actions">
              <h2>Bản xuất chính thức</h2>
              <button onClick={() => exportOfficialExcel(reports, meta)}><FileSpreadsheet size={18} /> Excel chính thức</button>
              <button onClick={() => exportDocx(reports, meta)}><FileText size={18} /> Word chính thức</button>
              <button onClick={() => exportPdf(reports, meta)}><FileText size={18} /> PDF chính thức</button>
              <p className="muted">Chỉ chứa biểu mẫu và số liệu báo cáo; không chứa công thức, trạng thái mapping hoặc dữ liệu kiểm tra nội bộ.</p>
              <hr />
              <h2>Bản QA nội bộ</h2>
              <button onClick={() => exportQaExcel(reports, rows, meta)}><FileSpreadsheet size={18} /> Excel QA</button>
              <p className="muted">Chứa công thức, trạng thái mapping, validation, cash QA và tối đa 5.000 dòng nguồn để rà soát nội bộ.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function metaLabel(key: string) {
  return ({
    companyName: "Đơn vị báo cáo",
    address: "Địa chỉ",
    taxCode: "Mã số thuế",
    year: "Năm",
    startDate: "Từ ngày",
    endDate: "Đến ngày",
    currency: "Đơn vị tính",
    preparedDate: "Ngày phê duyệt",
  } as Record<string, string>)[key] ?? key;
}

function formatDateTime(value: string | null) {
  if (!value) return "Chưa đăng nhập";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN");
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand auth-brand">
          <WalletCards size={24} />
          <span>BOO - BCTC TT99</span>
        </div>
        <h1>Đăng nhập</h1>
        <p>Vui lòng đăng nhập để truy cập dữ liệu PostgreSQL và báo cáo tài chính.</p>
        <label>
          <span>User</span>
          <input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <div className="issue error"><AlertCircle size={18} /><div><strong>Lỗi đăng nhập</strong><p>{error}</p></div></div>}
        <button className="primary-action auth-submit" type="submit" disabled={submitting || !username.trim() || !password}>
          {submitting ? "Đang đăng nhập..." : "Đăng nhập"}
        </button>
      </form>
    </div>
  );
}

function LedgerPreview({ rows, compact = false }: { rows: LedgerRow[]; compact?: boolean }) {
  if (!rows.length) return <div className="empty">Chưa có dữ liệu.</div>;
  return (
    <div className="table-wrap">
      <table className={compact ? "compact" : ""}>
        <thead>
          <tr>
            <th>Role</th>
            <th>Journal</th>
            <th>Ngày</th>
            <th>TK</th>
            <th>Tên TK</th>
            <th>Đối ứng</th>
            <th>Nợ</th>
            <th>Có</th>
            <th>Diễn giải</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.periodRole || row.bucket}</td>
              <td>{row.journalId || row.journalNum}</td>
              <td>{row.postingDate}</td>
              <td>{row.accountCode || row.rootAccountCode}</td>
              <td>{row.accountName}</td>
              <td>{row.oppositeAccounts?.join(", ")}</td>
              <td className="num">{formatMoney(row.debit)}</td>
              <td className="num">{formatMoney(row.credit)}</td>
              <td>{row.sourceNum}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CountsPreview({ result }: { result: GenerateReportsResponse }) {
  return (
    <div className="mapping-list">
      {Object.entries(result.counts).map(([key, value]) => (
        <div className="mapping-row" key={key}>
          <strong>{key}</strong>
          <span>{Number(value).toLocaleString("vi-VN")}</span>
        </div>
      ))}
      <div className="mapping-row">
        <strong>Kỳ trước B02/B03</strong>
        <span>{result.period.priorStartDate} - {result.period.priorEndDate}</span>
      </div>
      <div className="mapping-row">
        <strong>Số đầu năm B01</strong>
        <span>{result.period.openingBalanceDate || "N/A"}</span>
      </div>
      <div className="mapping-row">
        <strong>Unclassified</strong>
        <span>{result.unclassifiedSummary.reduce((total, row) => total + row.count, 0).toLocaleString("vi-VN")} dòng</span>
      </div>
    </div>
  );
}

function UnclassifiedServerSummary({ result, onExport, exporting }: { result: GenerateReportsResponse; onExport: () => void; exporting: string }) {
  const totalCount = result.unclassifiedSummary.reduce((total, row) => total + row.count, 0);
  if (!totalCount) return <div className="empty">Không có dòng tiền cần phân loại.</div>;
  return (
    <div className="mapping-list">
      {result.unclassifiedSummary.map((row) => (
        <div className="mapping-row" key={row.reason}>
          <strong>{row.reason || "No B03 rule matched"}</strong>
          <span>{row.count.toLocaleString("vi-VN")} dòng - {formatMoney(row.total)}</span>
        </div>
      ))}
      <div className="inline-actions">
        <button onClick={onExport} disabled={Boolean(exporting)}>
          <FileSpreadsheet size={16} /> Export {totalCount.toLocaleString("vi-VN")} dòng cần xử lý
        </button>
      </div>
    </div>
  );
}

const payableBuckets: Array<{ key: PayableAgingBucket; label: string }> = [
  { key: "age0To30", label: "0-30 ngày" },
  { key: "age31To60", label: "31-60 ngày" },
  { key: "age61To90", label: "61-90 ngày" },
  { key: "age91To120", label: "91-120 ngày" },
  { key: "ageOver120", label: "Trên 120 ngày" },
];

function AgingAmountButton({
  value,
  onClick,
  disabled,
}: {
  value: number;
  onClick: () => void;
  disabled: boolean;
}) {
  if (!value) return <span>{formatMoney(value)}</span>;
  return (
    <button className="link-button amount-link" onClick={onClick} disabled={disabled} title="Export raw source">
      {formatMoney(value)}
    </button>
  );
}

function PayableAgingTable({
  report,
  onExportRaw,
  exporting,
}: {
  report: PayableAgingResponse;
  onExportRaw: (row: PayableAgingRow, bucket: PayableAgingBucket | "") => void;
  exporting: boolean;
}) {
  return (
    <>
      <div className="mapping-list trial-summary">
        <div className="mapping-row">
          <strong>Ngày báo cáo</strong>
          <span>{report.period.endDate}</span>
        </div>
        <div className="mapping-row">
          <strong>Tài khoản</strong>
          <span>331</span>
        </div>
        <div className="mapping-row">
          <strong>Số dòng journal</strong>
          <span>{report.controls.journalRows.toLocaleString("vi-VN")}</span>
        </div>
      </div>
      <div className="table-wrap payable-aging-table">
        <table>
          <thead>
            <tr>
              <th>Tên đối tác</th>
              <th>Tổng nợ</th>
              <th>Nợ</th>
              {payableBuckets.map((bucket) => (
                <th key={bucket.key}>{bucket.label}</th>
              ))}
              <th>Dòng</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.accountAnalytic}>
                <td className="entity-cell"><strong>{row.accountAnalytic}</strong></td>
                <td className="num">{formatMoney(row.totalDebt)}</td>
                <td className="num">
                  <AgingAmountButton value={row.debt} onClick={() => onExportRaw(row, "")} disabled={exporting} />
                </td>
                {payableBuckets.map((bucket) => (
                  <td className="num" key={bucket.key}>
                    <AgingAmountButton value={row[bucket.key]} onClick={() => onExportRaw(row, bucket.key)} disabled={exporting} />
                  </td>
                ))}
                <td className="num">
                  <div className="row-actions">
                    <span>{row.rowCount.toLocaleString("vi-VN")}</span>
                    <button className="mini-button" onClick={() => onExportRaw(row, "")} disabled={exporting}>Raw</button>
                  </div>
                </td>
              </tr>
            ))}
            <tr className="bold">
              <td>Tổng cộng</td>
              <td className="num">{formatMoney(report.totals.totalDebt)}</td>
              <td className="num">{formatMoney(report.totals.debt)}</td>
              {payableBuckets.map((bucket) => (
                <td className="num" key={bucket.key}>{formatMoney(report.totals[bucket.key])}</td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function TrialBalanceTable({
  report,
  onExportRaw,
  exporting,
}: {
  report: TrialBalanceResponse;
  onExportRaw: (row: TrialBalanceRow) => void;
  exporting: boolean;
}) {
  return (
    <>
      <div className="mapping-list trial-summary">
        <div className="mapping-row">
          <strong>Kỳ báo cáo</strong>
          <span>{report.period.startDate} - {report.period.endDate}</span>
        </div>
        <div className="mapping-row">
          <strong>Dư đầu kỳ</strong>
          <span>Lũy kế đến {report.period.openingDate}</span>
        </div>
        <div className="mapping-row">
          <strong>Số dòng aggregate</strong>
          <span>{report.rows.length.toLocaleString("vi-VN")}</span>
        </div>
      </div>
      <div className="table-wrap trial-table">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>Root TK</th>
              <th rowSpan={2}>Tiểu khoản</th>
              <th rowSpan={2}>Tên tài khoản / Đối tượng</th>
              <th colSpan={2}>Dư đầu</th>
              <th colSpan={2}>Phát sinh</th>
              <th colSpan={2}>Dư cuối</th>
              <th rowSpan={2}>Dòng</th>
            </tr>
            <tr>
              <th>Nợ</th>
              <th>Có</th>
              <th>Nợ</th>
              <th>Có</th>
              <th>Nợ</th>
              <th>Có</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, index) => (
              <tr key={`${row.accountCode}-${row.accountAnalytic}-${index}`}>
                <td>{row.rootAccountCode}</td>
                <td>{row.accountCode}</td>
                <td className="entity-cell">
                  <strong>{row.accountAnalytic || row.accountName}</strong>
                  {row.accountAnalytic && <p className="muted">TK: {row.accountName}</p>}
                </td>
                <td className="num">{formatMoney(row.openingDebit)}</td>
                <td className="num">{formatMoney(row.openingCredit)}</td>
                <td className="num">{formatMoney(row.periodDebit)}</td>
                <td className="num">{formatMoney(row.periodCredit)}</td>
                <td className="num">{formatMoney(row.closingDebit)}</td>
                <td className="num">{formatMoney(row.closingCredit)}</td>
                <td className="num">
                  <div className="row-actions">
                    <span>{row.rowCount.toLocaleString("vi-VN")}</span>
                    <button className="mini-button" onClick={() => onExportRaw(row)} disabled={exporting}>
                      Raw
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            <tr className="bold">
              <td colSpan={3}>Tổng</td>
              <td className="num">{formatMoney(report.totals.openingDebit)}</td>
              <td className="num">{formatMoney(report.totals.openingCredit)}</td>
              <td className="num">{formatMoney(report.totals.periodDebit)}</td>
              <td className="num">{formatMoney(report.totals.periodCredit)}</td>
              <td className="num">{formatMoney(report.totals.closingDebit)}</td>
              <td className="num">{formatMoney(report.totals.closingCredit)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function ServerDrilldown({ rows, total, page, loading, reconciliation, onPage }: { rows: DrilldownRow[]; total: number; page: number; loading: string; reconciliation: DrilldownReconciliation | null; onPage: (page: number) => void }) {
  if (loading) return <p className="muted">{loading}</p>;
  if (!rows.length) return <div className="empty">Không có phát sinh theo đúng predicate của dòng báo cáo.</div>;
  return (
    <>
      {reconciliation && (
        <p className={reconciliation.reconciled ? "reconciliation-ok" : "reconciliation-error"}>
          Tổng drilldown {formatMoney(reconciliation.drilldownAmount)} / số báo cáo {reconciliation.reportedAmount === null ? "Chưa nhập" : formatMoney(reconciliation.reportedAmount)}
          {reconciliation.difference !== null && ` — chênh lệch ${formatMoney(reconciliation.difference)}`}
        </p>
      )}
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>Nguồn/predicate</th>
              <th>Ngày</th>
              <th>Tài khoản</th>
              <th>Đối tượng/đối ứng</th>
              <th>Số tiền</th>
              <th>Lý do</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.journalId}-${index}`}>
                <td>{row.journalId || row.journalNum}</td>
                <td>{String(row.postingDate).slice(0, 10)}</td>
                <td>{row.accountCode}</td>
                <td>{row.oppositeAccounts.join(", ")}</td>
                <td className="num">{formatMoney(row.amount)}</td>
                <td>{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}>Trước</button>
        <span>Trang {page} / {Math.max(1, Math.ceil(total / 100))} - {total.toLocaleString("vi-VN")} dòng</span>
        <button disabled={page >= Math.ceil(total / 100)} onClick={() => onPage(page + 1)}>Sau</button>
      </div>
    </>
  );
}

function AccountSummary({ rows }: { rows: LedgerRow[] }) {
  type AccountTotal = { code: string; name: string; debit: number; credit: number; count: number };
  const accountMap: Map<string, AccountTotal> = new Map();
  rows.forEach((row) => {
    const code = row.accountCode || row.rootAccountCode || "N/A";
    const entry = accountMap.get(code) ?? { code, name: row.accountName, debit: 0, credit: 0, count: 0 };
    entry.debit += row.debit;
    entry.credit += row.credit;
    entry.count += 1;
    accountMap.set(code, entry);
  });
  const accounts = Array.from(accountMap.values()).sort((a, b) => a.code.localeCompare(b.code)).slice(0, 100);
  if (!accounts.length) return <div className="empty">Chưa có tài khoản.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>TK</th><th>Tên</th><th>Dòng</th><th>Nợ</th><th>Có</th></tr></thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.code}>
              <td>{account.code}</td><td>{account.name}</td><td className="num">{account.count}</td><td className="num">{formatMoney(account.debit)}</td><td className="num">{formatMoney(account.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportTable({ reportId, rows, onSelect }: { reportId: ReportId; rows: ReportRow[]; onSelect: (row: ReportRow) => void }) {
  const currentLabel = reportId === "B01" ? "Số cuối năm" : "Năm nay";
  const priorLabel = reportId === "B01" ? "Số đầu năm" : "Năm trước";
  return (
    <div className="table-wrap report-table">
      <table>
        <thead><tr><th>Chỉ tiêu</th><th>Mã số</th><th>Thuyết minh</th><th>{currentLabel}</th><th>{priorLabel}</th></tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.code}-${index}`} className={row.bold ? "bold" : ""} onClick={() => onSelect(row)}>
              <td style={{ paddingLeft: 14 + row.level * 18 }}>{row.label}</td>
              <td>{row.code}</td>
              <td>{row.requiresManualMapping ? "Cần mapping" : row.note}</td>
              <td className="num">{formatMoney(row.current)}</td>
              <td className="num">{formatMoney(row.prior)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotesPreview({ reports }: { reports: ReturnType<typeof generateReports> }) {
  return (
    <div className="notes">
      {reports.B09.map((section) => (
        <article key={section.title}>
          <h2>{section.title}</h2>
          {noteBlocksForPreview(section).map((block, blockIndex) => block.type === "paragraph" ? (
            <p key={`${section.title}-p-${blockIndex}`}>{block.text}</p>
          ) : (
            <div className="table-wrap" key={`${section.title}-${block.table.templateIndex ?? blockIndex}`}>
              {block.table.title && <h3>{block.table.title}</h3>}
              <table>
                <thead>
                  <tr>{(block.table.templateRows?.[0] ?? block.table.columns).map((column, index) => <th key={index}>{column}</th>)}</tr>
                </thead>
                <tbody>
                  {(block.table.templateRows?.slice(1) ?? block.table.rows).map((row, index) => (
                    <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className={typeof cell === "number" ? "num" : cell === null ? "not-entered" : ""}>{typeof cell === "number" ? formatMoney(cell) : cell === null ? "Chưa nhập" : cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}

function noteBlocksForPreview(section: NoteSection): NoteBlock[] {
  if (section.blocks) return section.blocks;
  return [
    ...(section.paragraphs ?? []).map((text) => ({ type: "paragraph" as const, text })),
    ...(section.table ? [{ type: "table" as const, table: section.table }] : []),
    ...(section.tables ?? []).map((table) => ({ type: "table" as const, table })),
  ];
}
