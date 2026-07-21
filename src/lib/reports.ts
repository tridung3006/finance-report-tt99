import { b01Lines, b02Lines, b03Lines, cashFlowRules } from "../config/templates";
import type { CashMovement, GeneratedReports, JournalEntry, LedgerRow, LineRule, NoteSection, ReportRow, ValidationIssue } from "../types/finance";
import { buildB09FromTemplate } from "./b09Template";

const cashPrefixes = ["111", "112", "113"];
const excludedVirtualAccountNames = new Set(["more account 111/112", "more account 131"]);

function isVirtualAccount(row: LedgerRow) {
  return excludedVirtualAccountNames.has(String(row.accountName || "").trim().toLowerCase());
}

function codeOf(row: LedgerRow) {
  return (row.accountCode || row.rootAccountCode || "").replace(/^0+/, "");
}

function matchesCode(code: string, prefixes: string[] = []) {
  const normalized = code.replace(/^0+/, "");
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function matches(row: LedgerRow, prefixes: string[] = []) {
  return matchesCode(codeOf(row), prefixes);
}

function normalizeText(value: string) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

function valueByNormalSide(row: LedgerRow, normalSide?: "debit" | "credit") {
  if (normalSide === "credit") return row.credit - row.debit;
  return row.debit - row.credit;
}

function valueFor(rule: LineRule, rows: LedgerRow[]) {
  const relevant = rows.filter((row) => matches(row, rule.accountPrefixes) && !matches(row, rule.excludeAccountPrefixes));
  if (rule.manualOnly) return { value: rule.nullWhenManual ? null : 0, sources: [] };
  if (rule.side === "balance") {
    const rawBalance = rule.grossByCounterparty
      ? (() => {
          const byAccount = new Map<string, number>();
          for (const row of relevant) {
            const counterparty = String(row.accountAnalytic || "").trim() || "NO_COUNTERPARTY";
            const key = `${codeOf(row)}|${counterparty}`;
            byAccount.set(key, (byAccount.get(key) ?? 0) + valueByNormalSide(row, rule.normalSide));
          }
          return Array.from(byAccount.values()).reduce((total, value) => total + Math.max(0, value), 0);
        })()
      : relevant.reduce((total, row) => total + valueByNormalSide(row, rule.normalSide), 0);
    return { value: rawBalance * (rule.sign ?? 1), sources: relevant };
  }
  const raw = relevant.reduce((total, row) => {
    if (rule.side === "credit") return total + row.credit - row.debit;
    if (rule.side === "debit") return total + row.debit - row.credit;
    return total + valueByNormalSide(row, rule.normalSide);
  }, 0);
  return { value: raw * (rule.sign ?? 1), sources: relevant };
}

function evaluate(expression: string, values: Map<string, number>) {
  return expression
    .replace(/\s/g, "")
    .split(/(?=[+-])/)
    .reduce((total, token) => {
      const sign = token.startsWith("-") ? -1 : 1;
      const code = token.replace(/^[+-]/, "");
      return total + sign * (values.get(code) ?? 0);
    }, 0);
}

function buildLineReport(lines: LineRule[], current: LedgerRow[], prior: LedgerRow[], label: "period" | "balance"): ReportRow[] {
  const currentValues = new Map<string, number>();
  const priorValues = new Map<string, number>();
  const sourceMap = new Map<string, LedgerRow[]>();

  for (const line of lines) {
    if (line.accountPrefixes) {
      const currentResult = valueFor(line, current);
      const priorResult = valueFor(line, prior);
      if (line.code) {
        if (currentResult.value !== null) currentValues.set(line.code, currentResult.value);
        if (priorResult.value !== null) priorValues.set(line.code, priorResult.value);
        sourceMap.set(line.code, currentResult.sources);
      }
    }
  }

  for (let pass = 0; pass < 4; pass += 1) {
    for (const line of lines) {
      if (line.expression && line.code) {
        currentValues.set(line.code, evaluate(line.expression, currentValues));
        priorValues.set(line.code, evaluate(line.expression, priorValues));
      }
    }
  }

  return lines.map((line) => {
    return {
      label: line.label,
      code: line.code,
      note: line.note,
      current: line.code ? currentValues.get(line.code) ?? null : null,
      prior: line.code ? priorValues.get(line.code) ?? null : null,
      level: line.level,
      bold: line.bold,
      negative: line.negative,
      formula: line.expression ?? (line.accountPrefixes ? `${label}: ${line.accountPrefixes.join(", ")}` : ""),
      sourceRef: line.sourceRef,
      requiresManualMapping: line.requiresManualMapping,
      sourceAccounts: line.accountPrefixes,
      sources: line.code ? sourceMap.get(line.code) ?? [] : [],
    };
  });
}

function groupEntries(rows: LedgerRow[]) {
  const grouped = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = row.entryGroupKey || row.journalId || `${row.journalNum}|${row.postingDate}|${row.sourceNum}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return Array.from(grouped.entries()).map(([key, entryRows]): JournalEntry => {
    const debit = entryRows.reduce((total, row) => total + row.debit, 0);
    const credit = entryRows.reduce((total, row) => total + row.credit, 0);
    return {
      key,
      postingDate: entryRows[0]?.postingDate ?? "",
      journalId: entryRows[0]?.journalId ?? "",
      journalNum: entryRows[0]?.journalNum ?? "",
      sourceNum: entryRows[0]?.sourceNum ?? "",
      rows: entryRows,
      debit,
      credit,
      balanced: Math.abs(debit - credit) <= 1,
    };
  });
}

function excludesClosingEntries(rows: LedgerRow[]) {
  return groupEntries(rows)
    .filter((entry) => !entry.rows.some((row) => matches(row, ["911"])))
    .flatMap((entry) => entry.rows);
}

function movementFromEntry(entry: JournalEntry): CashMovement[] {
  const cashRows = entry.rows.filter((row) => matches(row, cashPrefixes));
  const movements: CashMovement[] = [];
  for (const cashRow of cashRows) {
      const amount = cashRow.debit - cashRow.credit;
      if (Math.abs(amount) <= 0) continue;
      const oppositeRows = entry.rows.filter((row) => row.id !== cashRow.id && !matches(row, cashPrefixes));
      const oppositeAccounts = Array.from(new Set(oppositeRows.map(codeOf).filter(Boolean)));
      const direction = amount >= 0 ? "in" : "out";
      const weightedRows = oppositeRows
        .map((row) => ({
          row,
          weight: direction === "in" ? Math.max(0, row.credit - row.debit) : Math.max(0, row.debit - row.credit),
        }))
        .filter((item) => codeOf(item.row) && item.weight > 0);
      const allocated = weightedRows.reduce((total, item) => total + item.weight, 0);
      if (cashRows.length === 1 && weightedRows.length > 1 && Math.abs(allocated - Math.abs(amount)) <= 1) {
        for (const item of weightedRows) {
          const itemAccount = codeOf(item.row);
          movements.push({
            entryKey: entry.key,
            cashRow: { ...cashRow, oppositeAccounts: [itemAccount] },
            amount: direction === "in" ? item.weight : -item.weight,
            direction,
            oppositeRows: [item.row],
            oppositeAccounts: [itemAccount],
            cashPeerCount: 0,
          });
        }
        continue;
      }
      movements.push({
        entryKey: entry.key,
        cashRow: { ...cashRow, oppositeAccounts },
        amount,
        direction,
        oppositeRows,
        oppositeAccounts,
        cashPeerCount: cashRows.length - 1,
      });
  }
  return movements;
}

function classifyMovementLegacy(movement: CashMovement) {
  const text = normalizeText(`${movement.cashRow.sourceNum} ${movement.cashRow.journalName} ${movement.cashRow.accountName} ${movement.cashRow.accountType}`);
  if (!movement.oppositeAccounts.length && (movement.cashPeerCount || 0) > 0) {
    return { ...movement, matchedCode: "__internal_cash_transfer", reason: "Chuyển tiền nội bộ giữa 111/112/113 - loại khỏi B03" };
  }

  const scoredMatches = cashFlowRules.filter((rule) => {
    if (rule.direction !== movement.direction) return false;
    return Boolean(rule.oppositeAccountPrefixes?.some((prefix) => movement.oppositeAccounts.some((account) => matchesCode(account, [prefix]))));
  }).map((rule) => ({
    rule,
    score: Math.max(...(rule.oppositeAccountPrefixes || []).filter((prefix) => movement.oppositeAccounts.some((account) => matchesCode(account, [prefix]))).map((prefix) => prefix.length)),
  }));
  const maxSpecificity = scoredMatches.length ? Math.max(...scoredMatches.map((item) => item.score)) : 0;
  const accountMatched = scoredMatches.filter((item) => item.score === maxSpecificity).map((item) => item.rule);
  if (accountMatched.length === 1) return { ...movement, matchedCode: accountMatched[0].code, reason: `Đối ứng: ${movement.oppositeAccounts.join(", ")}` };
  if (accountMatched.length > 1) return { ...movement, reason: `Match nhiều rule theo tài khoản: ${accountMatched.map((rule) => rule.code).join(", ")}` };

  const matched = cashFlowRules.filter((rule) => rule.direction === movement.direction && rule.textIncludes?.some((needle) => text.includes(needle)));
  if (matched.length === 1) return { ...movement, matchedCode: matched[0].code, reason: `Đối ứng: ${movement.oppositeAccounts.join(", ")}` };
  if (matched.length > 1) return { ...movement, reason: `Match nhiều rule theo nội dung: ${matched.map((rule) => rule.code).join(", ")}` };
  return { ...movement, reason: movement.oppositeAccounts.length ? `Chưa có rule cho đối ứng: ${movement.oppositeAccounts.join(", ")}` : "Không xác định được tài khoản đối ứng" };
}

function classifyMovement(movement: CashMovement) {
  const text = normalizeText(`${movement.cashRow.sourceNum} ${movement.cashRow.journalName} ${movement.cashRow.accountName} ${movement.cashRow.accountType}`);
  if (!movement.oppositeAccounts.length && (movement.cashPeerCount || 0) > 0) {
    return { ...movement, matchedCode: "__internal_cash_transfer", reason: "Chuyển tiền nội bộ giữa 111/112/113 - loại khỏi B03" };
  }

  const isFxRevaluation = ["danh gia lai", "chenh lech ty gia", "revaluation", "exchange difference"].some((needle) => text.includes(needle));
  if (isFxRevaluation && movement.oppositeAccounts.some((account) => matchesCode(account, ["413", "515", "635"]))) {
    return { ...movement, matchedCode: "61", reason: "Ảnh hưởng đánh giá lại tiền và tương đương tiền bằng ngoại tệ" };
  }

  const accountMatched = cashFlowRules.filter((rule) => {
    if (rule.direction !== movement.direction) return false;
    return Boolean(
      rule.oppositeAccountPrefixes?.some((prefix) =>
        movement.oppositeAccounts.some((account) => matchesCode(account, [prefix]) && !matchesCode(account, rule.excludeAccountPrefixes || [])),
      ),
    );
  });
  const accountCodes = Array.from(new Set(accountMatched.map((rule) => rule.code)));
  if (accountCodes.length === 1) return { ...movement, matchedCode: accountCodes[0], reason: `Đối ứng: ${movement.oppositeAccounts.join(", ")}` };
  if (accountCodes.length > 1) return { ...movement, reason: `Nhiều mã B03 có thể áp dụng (${accountCodes.join(", ")}): ${movement.oppositeAccounts.join(", ")}` };

  const matched = cashFlowRules.filter((rule) => rule.direction === movement.direction && rule.textIncludes?.some((needle) => text.includes(needle)));
  const textCodes = Array.from(new Set(matched.map((rule) => rule.code)));
  if (textCodes.length === 1) return { ...movement, matchedCode: textCodes[0], reason: "Phân loại theo nội dung chứng từ" };
  if (textCodes.length > 1) return { ...movement, reason: `Nội dung khớp nhiều mã B03: ${textCodes.join(", ")}` };
  return { ...movement, reason: movement.oppositeAccounts.length ? `Chưa có rule cho đối ứng: ${movement.oppositeAccounts.join(", ")}` : "Không xác định được tài khoản đối ứng" };
}

function buildCashFlow(current: LedgerRow[], prior: LedgerRow[], currentOpeningCash: number, priorOpeningCash: number) {
  const currentMovements = groupEntries(current).flatMap(movementFromEntry).map(classifyMovement);
  const priorMovements = groupEntries(prior).flatMap(movementFromEntry).map(classifyMovement);
  const currentTotals = new Map<string, number>();
  const priorTotals = new Map<string, number>();

  for (const movement of currentMovements) {
    if (movement.matchedCode) currentTotals.set(movement.matchedCode, (currentTotals.get(movement.matchedCode) ?? 0) + movement.amount);
  }
  for (const movement of priorMovements) {
    if (movement.matchedCode) priorTotals.set(movement.matchedCode, (priorTotals.get(movement.matchedCode) ?? 0) + movement.amount);
  }

  if (!currentTotals.has("61")) currentTotals.set("61", 0);
  if (!priorTotals.has("61")) priorTotals.set("61", 0);
  currentTotals.set("60", currentOpeningCash);
  priorTotals.set("60", priorOpeningCash);

  const rows: ReportRow[] = b03Lines.map((line) => {
    let currentValue = line.code ? currentTotals.get(line.code) ?? 0 : null;
    let priorValue = line.code ? priorTotals.get(line.code) ?? 0 : null;
    if (line.expression) {
      currentValue = evaluate(line.expression, currentTotals);
      priorValue = evaluate(line.expression, priorTotals);
      currentTotals.set(line.code, currentValue);
      priorTotals.set(line.code, priorValue);
    }
    return {
      label: line.label,
      code: line.code,
      current: currentValue,
      prior: priorValue,
      level: line.level,
      bold: line.bold,
      negative: line.negative,
      formula: line.expression ?? "Dòng tiền 111/112/113 phân loại theo tài khoản đối ứng trong cùng bút toán",
      sourceRef: line.sourceRef,
      requiresManualMapping: line.requiresManualMapping,
      sources: line.code ? currentMovements.filter((movement) => movement.matchedCode === line.code).map((movement) => movement.cashRow) : [],
      sourceAccounts: line.code ? Array.from(new Set(currentMovements.filter((movement) => movement.matchedCode === line.code).flatMap((movement) => movement.oppositeAccounts))) : [],
    };
  });
  return {
    rows,
    movements: currentMovements,
    unclassified: currentMovements.filter((movement) => !movement.matchedCode).map((movement) => movement.cashRow),
  };
}

function reportValue(rows: ReportRow[], code: string, side: "current" | "prior" = "current") {
  return rows.find((row) => row.code === code)?.[side] ?? 0;
}

function validate(allRows: LedgerRow[], B01: ReportRow[], B03: ReportRow[], cash: ReturnType<typeof buildCashFlow>) {
  const issues: ValidationIssue[] = [];
  const missingAccount = allRows.filter((row) => !codeOf(row));
  const missingDate = allRows.filter((row) => !row.postingDate);
  const periodRows = allRows.filter((row) => row.periodRole === "current" || row.periodRole === "prior" || row.periodRole === "opening");
  const unbalancedEntries = groupEntries(periodRows).filter((entry) => !entry.balanced);
  const totalAssets = reportValue(B01, "280");
  const totalEquityLiabilities = reportValue(B01, "440");
  const b03EndCash = reportValue(B03, "70");
  const b01Cash = reportValue(B01, "110");

  if (missingAccount.length) issues.push({ severity: "error", title: "Dòng thiếu tài khoản", detail: `${missingAccount.length} dòng không có account_code/root_account_code.`, rows: missingAccount });
  if (missingDate.length) issues.push({ severity: "warning", title: "Dòng thiếu ngày hạch toán", detail: `${missingDate.length} dòng không có posting_date.`, rows: missingDate });
  if (unbalancedEntries.length) issues.push({ severity: "error", title: "Bút toán lệch Nợ/Có", detail: `${unbalancedEntries.length} bút toán/group không cân Nợ Có.` });
  if (Math.abs(totalAssets - totalEquityLiabilities) > 1) issues.push({ severity: "error", title: "B01 chưa cân", detail: `Tổng tài sản ${totalAssets.toLocaleString("vi-VN")} khác tổng nguồn vốn ${totalEquityLiabilities.toLocaleString("vi-VN")}.` });
  if (Math.abs(b03EndCash - b01Cash) > 1) issues.push({ severity: "warning", title: "B03 không khớp B01 tiền", detail: `B03 mã 70 ${b03EndCash.toLocaleString("vi-VN")} khác B01 mã 110 ${b01Cash.toLocaleString("vi-VN")}. Kiểm tra tương đương tiền và FX.` });
  if (cash.unclassified.length) issues.push({ severity: "warning", title: "Dòng tiền cần phân loại", detail: `${cash.unclassified.length} dòng tiền không đủ chắc để đưa vào B03.`, rows: cash.unclassified });
  const unallocatedProductionCosts = allRows.filter((row) => matches(row, ["621", "622", "627"])).reduce((total, row) => total + row.debit - row.credit, 0);
  if (Math.abs(unallocatedProductionCosts) > 1) issues.push({ severity: "warning", title: "Chi phí sản xuất chưa phân bổ/kết chuyển", detail: `Các tài khoản 621/622/627 còn số dư ròng ${unallocatedProductionCosts.toLocaleString("vi-VN")}; B02 cần được rà soát sau khi hoàn tất phân bổ giá thành.` });
  const interestReceiptReviewCount = cash.movements.filter((movement) => movement.matchedCode === "27" && movement.oppositeAccounts.some((account) => matchesCode(account, ["515111"]))).length;
  if (interestReceiptReviewCount) issues.push({ severity: "warning", title: "Rà soát lãi tiền gửi B03", detail: `${interestReceiptReviewCount} khoản thu đối ứng 515111 đang vào mã 27; lãi tiền gửi không kỳ hạn phải chuyển sang mã 01.` });
  issues.push({ severity: "info", title: "B09-DN có nội dung chưa nhập", detail: "Ứng dụng giữ nguyên 53 bảng nội dung của mẫu B09-DN. Các ô không thể xác định đáng tin cậy từ journal được để trống/chưa nhập và phải được người lập bổ sung, phê duyệt trước khi phát hành." });
  issues.push({ severity: "info", title: "Nguồn công thức", detail: "Các dòng có sourceRef theo TT99; dòng cần split ngắn/dài hạn hoặc disclosure ngoài journal được đánh dấu manual mapping." });
  return issues;
}

function legacyNotes(B01: ReportRow[], B02: ReportRow[], B03: ReportRow[]): NoteSection[] {
  const manual = "Cần người lập bổ sung chi tiết theo sổ phụ, hợp đồng và hồ sơ ngoài journal";
  const sum = (report: ReportRow[], codes: string[], side: "current" | "prior") =>
    codes.reduce((total, code) => total + reportValue(report, code, side), 0);
  const row = (number: number, label: string, report?: ReportRow[], codes: string[] = []): Array<string | number | null> => [
    `${number}. ${label}`,
    report ? sum(report, codes, "current") : null,
    report ? sum(report, codes, "prior") : null,
    report ? `${report === B01 ? "B01" : report === B02 ? "B02" : "B03"}.${codes.join("+")}; ${manual}` : `Chưa nhập; ${manual}`,
  ];
  const sections: NoteSection[] = [
    { title: "I. Đặc điểm hoạt động của doanh nghiệp", paragraphs: [
      "1. Hình thức sở hữu vốn; 2. Lĩnh vực kinh doanh; 3. Ngành nghề kinh doanh; 4. Chu kỳ sản xuất, kinh doanh thông thường - Cần bổ sung.",
      "5. Đặc điểm hoạt động trong năm; 6. Cấu trúc doanh nghiệp; 7. Lao động cuối kỳ/bình quân - Cần bổ sung.",
      "8. Khả năng so sánh thông tin; 9. Thông tin khác theo pháp luật liên quan - Cần bổ sung.",
    ] },
    { title: "II. Kỳ kế toán, đơn vị tiền tệ sử dụng trong kế toán", paragraphs: [
      "1. Kỳ kế toán năm: cần xác nhận ngày bắt đầu và ngày kết thúc.",
      "2. Đơn vị tiền tệ sử dụng và ảnh hưởng của việc thay đổi (nếu có) - Cần bổ sung.",
    ] },
    { title: "III. Chuẩn mực và Chế độ kế toán áp dụng", paragraphs: [
      "1. Chế độ kế toán áp dụng: Thông tư 99/2025/TT-BTC - Người lập phải xác nhận.",
      "2. Tuyên bố tuân thủ Chuẩn mực kế toán Việt Nam và Chế độ kế toán; giải trình ngoại lệ nếu có.",
    ] },
    { title: "IV. Các chính sách kế toán, ước tính kế toán và quy định pháp luật có liên quan", paragraphs: [
      "Các mục 1-5: chuyển đổi BCTC ngoại tệ, tỷ giá, lãi suất thực tế, tiền/tương đương tiền và đầu tư tài chính - Cần bổ sung.",
      "Các mục 6-10: nợ phải thu, hàng tồn kho, TSCĐ/BĐSĐT, tài sản sinh học và hợp đồng hợp tác kinh doanh - Cần bổ sung.",
      "Các mục 11-17: chi phí chờ phân bổ, phải trả người bán/cổ tức, chi phí phải trả, doanh thu chờ phân bổ, dự phòng và thuế TNDN hoãn lại - Cần bổ sung.",
      "Các mục 18-21: vay/nợ thuê tài chính, chi phí đi vay, trái phiếu chuyển đổi và vốn chủ sở hữu - Cần bổ sung.",
      "Các mục 22-29: doanh thu, giảm trừ doanh thu, giá vốn, chi phí tài chính/bán hàng/QLDN, thanh lý tài sản, thuế TNDN và chính sách khác - Cần bổ sung.",
    ] },
    { title: "V. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo tình hình tài chính", table: {
      columns: ["Khoản mục theo B09-DN", "Cuối năm", "Đầu năm", "Nguồn và mức hoàn thiện"],
      rows: [
        row(1, "Tiền và các khoản tương đương tiền", B01, ["110"]), row(2, "Các khoản đầu tư tài chính", B01, ["120", "260"]),
        row(3, "Phải thu của khách hàng", B01, ["131", "211"]), row(4, "Phải thu khác", B01, ["135", "215"]),
        row(5, "Tài sản thiếu chờ xử lý", B01, ["137"]), row(6, "Nợ xấu", B01, ["136", "216"]),
        row(7, "Hàng tồn kho", B01, ["140"]), row(8, "Tài sản dở dang dài hạn", B01, ["250"]),
        row(9, "Tăng, giảm TSCĐ hữu hình", B01, ["221"]), row(10, "Tăng, giảm TSCĐ vô hình", B01, ["227"]),
        row(11, "Tăng, giảm TSCĐ thuê tài chính", B01, ["224"]), row(12, "Tài sản sinh học", B01, ["150", "230"]),
        row(13, "Tăng, giảm bất động sản đầu tư", B01, ["240"]), row(14, "Chi phí chờ phân bổ", B01, ["161", "271"]),
        row(15, "Tài sản khác", B01, ["165", "274"]), row(16, "Vay và nợ thuê tài chính", B01, ["321", "339"]),
        row(17, "Phải trả người bán", B01, ["311", "331"]), row(18, "Phải trả về cổ tức, lợi nhuận", B01, ["313"]),
        row(19, "Thuế và các khoản phải nộp Nhà nước", B01, ["314", "333"]), row(20, "Chi phí phải trả", B01, ["316", "334"]),
        row(21, "Phải trả khác", B01, ["320", "338"]), row(22, "Doanh thu chờ phân bổ", B01, ["319", "337"]),
        row(23, "Trái phiếu phát hành", B01, ["340"]), row(24, "Cổ phiếu ưu đãi phân loại là nợ phải trả", B01, ["341"]),
        row(25, "Dự phòng phải trả", B01, ["322", "343"]), row(26, "Tài sản/thuế TNDN hoãn lại phải trả", B01, ["272", "342"]),
        row(27, "Vốn chủ sở hữu", B01, ["400"]), row(28, "Chênh lệch đánh giá lại tài sản", B01, ["416"]),
        row(29, "Chênh lệch tỷ giá", B01, ["417"]), row(30, "Các khoản mục ngoài Báo cáo tình hình tài chính"),
        row(31, "Tài sản của bên khác bị giới hạn sử dụng và nghĩa vụ theo hợp đồng/pháp luật"), row(32, "Các thông tin khác cần thuyết minh"),
      ],
    }, paragraphs: ["Các tổng số từ B01 là điểm đối chiếu; bảng tăng/giảm, kỳ hạn, đối tượng, tài sản bảo đảm và chi tiết bắt buộc vẫn phải được hoàn thiện."] },
    { title: "VII. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo kết quả hoạt động kinh doanh", table: {
      columns: ["Khoản mục theo B09-DN", "Năm nay", "Năm trước", "Nguồn và mức hoàn thiện"],
      rows: [row(1, "Tổng doanh thu bán hàng và cung cấp dịch vụ", B02, ["01"]), row(2, "Các khoản giảm trừ doanh thu", B02, ["02"]), row(3, "Giá vốn hàng bán", B02, ["11"]), row(4, "Lãi/lỗ bán, thanh lý BĐSĐT", B02, ["21"]), row(5, "Doanh thu hoạt động tài chính", B02, ["22"]), row(6, "Chi phí tài chính", B02, ["23"]), row(7, "Thu nhập khác", B02, ["31"]), row(8, "Chi phí khác", B02, ["32"]), row(9, "Chi phí bán hàng và QLDN", B02, ["25", "26"]), row(10, "Chi phí sản xuất, kinh doanh theo yếu tố"), row(11, "Chi phí thuế TNDN", B02, ["51", "52"])],
    } },
    { title: "VIII. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo lưu chuyển tiền tệ", table: {
      columns: ["Khoản mục theo B09-DN", "Năm nay", "Năm trước", "Nguồn và mức hoàn thiện"],
      rows: [row(1, "Tiền nắm giữ nhưng không được sử dụng"), row(2, "Giao dịch không bằng tiền"), row(3, "Số tiền đi vay thực thu", B03, ["33"]), row(4, "Số tiền đã thực trả gốc vay", B03, ["34", "35"]), row(5, "Mua và thanh lý công ty con")],
    } },
    { title: "IX. Những thông tin khác", paragraphs: [
      "1. Nợ tiềm tàng và cam kết; 2. Sự kiện sau ngày kết thúc kỳ kế toán; 3. Bên liên quan; 4. Báo cáo bộ phận - Cần bổ sung.",
      "5. Thông tin so sánh; 6. Giả định hoạt động liên tục; 7. Giả định và ước tính quan trọng; 8. Biện pháp/giải pháp khác - Cần bổ sung.",
    ] },
    { title: "X. Nội dung sửa đổi, bổ sung biểu mẫu và chỉ tiêu so với mẫu Bộ Tài chính", paragraphs: ["Tên chỉ tiêu, nội dung sửa đổi/bổ sung và lý do thay đổi - Cần bổ sung nếu có."] },
  ];
  for (const prefix of ["V", "VII", "VIII"]) {
    const section = sections.find((item) => item.title.startsWith(`${prefix}.`));
    if (!section?.table) continue;
    const periodColumns = prefix === "V" ? ["Cuối năm", "Đầu năm"] : ["Năm nay", "Năm trước"];
    section.tables = section.table.rows.map((summaryRow) => ({
      title: String(summaryRow[0]),
      columns: ["Chi tiết bắt buộc theo B09-DN", ...periodColumns, "Nguồn/Trạng thái"],
      rows: [
        ["Chi tiết theo đối tượng, tính chất, kỳ hạn và hồ sơ kế toán liên quan", null, null, "Chưa nhập"],
        ["Tổng đối chiếu với báo cáo chính", summaryRow[1], summaryRow[2], summaryRow[3]],
      ],
    }));
    delete section.table;
  }
  return sections;
}

function notes(B01: ReportRow[], B02: ReportRow[], B03: ReportRow[]): NoteSection[] {
  return buildB09FromTemplate(B01, B02, B03);
}

export function generateReports(rows: LedgerRow[]): GeneratedReports {
  const posted = rows.filter((row) => !isVirtualAccount(row) && String(row.status || "").trim() === "Posted");
  const current = posted.filter((row) => row.periodRole === "current" || (!row.periodRole && row.bucket === "current"));
  const prior = posted.filter((row) => row.periodRole === "prior" || (!row.periodRole && row.bucket === "prior"));
  const opening = posted.filter((row) => row.periodRole === "opening" || (!row.periodRole && row.bucket === "opening"));
  const currentBalance = posted.filter((row) => row.periodRole === "currentBalance");
  const priorBalance = posted.filter((row) => row.periodRole === "priorBalance");

  const B01 = buildLineReport(
    b01Lines,
    currentBalance.length ? currentBalance : [...opening, ...current],
    priorBalance.length ? priorBalance : prior,
    "balance",
  );
  const currentOperating = excludesClosingEntries(current);
  const priorOperating = excludesClosingEntries(prior);
  const B02 = buildLineReport(b02Lines, currentOperating, priorOperating, "period");
  const cash = buildCashFlow(current, prior, reportValue(B01, "110", "prior"), 0);
  const B03 = cash.rows;

  return {
    B01,
    B02,
    B03,
    B09: notes(B01, B02, B03),
    validations: validate(posted, B01, B03, cash),
    unclassifiedCashRows: cash.unclassified,
    cashMovements: cash.movements,
  };
}
