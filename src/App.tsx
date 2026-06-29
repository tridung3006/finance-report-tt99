import { AlertCircle, CheckCircle2, Database, Download, FileSpreadsheet, FileText, LayoutDashboard, Map as MapIcon, Upload, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchDrilldown, fetchPayableAging, fetchPayableAgingRawSource, fetchRawSource, fetchTrialBalance, fetchTrialBalanceRawSource, generateServerReports, getCurrentUser, login, logout, type AuthUser, type DrilldownRow, type GenerateReportsResponse, type PayableAgingBucket, type PayableAgingResponse, type PayableAgingRow, type RawSourceRow, type TrialBalanceResponse, type TrialBalanceRow } from "./lib/api";
import { fileToLedgerRows } from "./lib/csv";
import { exportDocx, exportExcel, exportPayableAgingWorkbook, exportPdf, exportProblemWorkbook, exportRawSourceWorkbook, exportTrialBalanceWorkbook } from "./lib/exporters";
import { formatMoney } from "./lib/format";
import { generateReports } from "./lib/reports";
import type { LedgerRow, PeriodMeta, ReportId, ReportRow, UploadBucket } from "./types/finance";

const nav = [
  { id: "data", label: "Data", icon: Database },
  { id: "upload", label: "CSV fallback", icon: Upload },
  { id: "mapping", label: "Mapping", icon: MapIcon },
  { id: "validation", label: "Validation", icon: CheckCircle2 },
  { id: "reports", label: "Reports", icon: LayoutDashboard },
  { id: "trial", label: "CĐ phát sinh", icon: FileSpreadsheet },
  { id: "payableAging", label: "Tuổi nợ NCC", icon: FileSpreadsheet },
  { id: "export", label: "Export", icon: Download },
] as const;

const buckets: Array<{ id: UploadBucket; label: string; hint: string }> = [
  { id: "current", label: "Kỳ hiện tại", hint: "CSV phát sinh trong kỳ báo cáo" },
  { id: "prior", label: "Kỳ trước", hint: "CSV năm/kỳ trước để so sánh" },
  { id: "opening", label: "Số dư đầu kỳ", hint: "CSV số dư nếu không dùng PostgreSQL" },
];

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
  }

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setServerResult(null);
    setRows([]);
    setSelectedLine(null);
  }

  async function queryPostgres() {
    setError("");
    setLoading("Đang query PostgreSQL...");
    try {
      const result = await generateServerReports(meta.startDate, meta.endDate);
      setServerResult(result);
      setRows([]);
      setQueryInfo(
        `Backend aggregate ${result.counts.currentRows.toLocaleString("vi-VN")} dòng kỳ hiện tại, ${result.counts.priorRows.toLocaleString("vi-VN")} dòng kỳ trước. Payload compact, formula ${result.formulaVersion}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không query được PostgreSQL");
    } finally {
      setLoading("");
    }
  }

  useEffect(() => {
    if (!serverResult || !selectedLine || reportTab === "B09" || !selectedLine.code) {
      setDrilldownRows([]);
      setDrilldownTotal(0);
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

  async function onUpload(files: FileList | null, bucket: UploadBucket) {
    if (!files?.length) return;
    setLoading(`Đang đọc ${files.length} file...`);
    const parsed = (await Promise.all(Array.from(files).map((file) => fileToLedgerRows(file, bucket)))).flat();
    setRows((current) => [...current, ...parsed]);
    setServerResult(null);
    setLoading("");
  }

  function clearBucket(bucket: UploadBucket) {
    setRows((current) => current.filter((row) => row.bucket !== bucket));
    setServerResult(null);
  }

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
        {nav.map((item) => {
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

        {active === "upload" && (
          <section className="grid three">
            {buckets.map((bucket) => {
              const count = rows.filter((row) => row.bucket === bucket.id).length;
              return (
                <div className="panel upload-panel" key={bucket.id}>
                  <div>
                    <h2>{bucket.label}</h2>
                    <p>{bucket.hint}</p>
                  </div>
                  <label className="dropzone">
                    <Upload size={28} />
                    <span>Chọn CSV</span>
                    <input type="file" accept=".csv,text/csv" multiple onChange={(event) => onUpload(event.target.files, bucket.id)} />
                  </label>
                  <div className="panel-foot">
                    <span>{count.toLocaleString("vi-VN")} dòng</span>
                    <button onClick={() => clearBucket(bucket.id)}>Xóa nhóm</button>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {active === "mapping" && (
          <section className="grid two">
            <div className="panel">
              <h2>Registry công thức TT99</h2>
              <div className="mapping-list">
                {[
                  ["B01", "Dùng số dư lũy kế đến ngày báo cáo; assert 280 = 440"],
                  ["B02", "Dùng phát sinh kỳ hiện tại/kỳ trước; assert 10, 20, 30, 40, 50, 60"],
                  ["B03", "Group theo journal_id; phân loại 111/112/113 theo tài khoản đối ứng"],
                  ["B03.01", "Inflow tiền đối ứng 511, 33311, 131, 121"],
                  ["B09", "Tự điền bảng có nguồn từ B01/B02/B03; phần định tính để kế toán rà soát"],
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

        {active === "validation" && (
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
                    <ServerDrilldown rows={drilldownRows} total={drilldownTotal} page={drilldownPage} loading={drilldownLoading} onPage={setDrilldownPage} />
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
              <h2>Xuất báo cáo</h2>
              <button onClick={() => exportExcel(reports, rows, meta)}><FileSpreadsheet size={18} /> Excel workbook</button>
              <button onClick={() => exportDocx(reports, meta)}><FileText size={18} /> Word DOCX</button>
              <button onClick={() => exportPdf(reports, meta)}><FileText size={18} /> PDF</button>
              <p className="muted">Excel có sheet QA cho formula/source rows. PDF nhúng Arial từ backend để render tiếng Việt.</p>
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

function ServerDrilldown({ rows, total, page, loading, onPage }: { rows: DrilldownRow[]; total: number; page: number; loading: string; onPage: (page: number) => void }) {
  if (loading) return <p className="muted">{loading}</p>;
  if (!rows.length) return <div className="empty">Không có drilldown hoặc report này chưa hỗ trợ drilldown.</div>;
  return (
    <>
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>
              <th>Journal</th>
              <th>Ngày</th>
              <th>TK tiền</th>
              <th>Đối ứng</th>
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
          {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          {section.table && (
            <div className="table-wrap">
              <table>
                <thead><tr>{section.table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {section.table.rows.map((row, index) => (
                    <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className={typeof cell === "number" ? "num" : ""}>{typeof cell === "number" ? formatMoney(cell) : cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
