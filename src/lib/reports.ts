import { b01Lines, b02Lines, b03Lines, cashFlowRules } from "../config/templates";
import type { CashMovement, GeneratedReports, JournalEntry, LedgerRow, LineRule, NoteSection, ReportRow, ValidationIssue } from "../types/finance";

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
  if (rule.manualOnly) return { value: 0, sources: [] };
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
        currentValues.set(line.code, currentResult.value);
        priorValues.set(line.code, priorResult.value);
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

function unclosedTemporaryResult(rows: LedgerRow[]) {
  return rows
    .filter((row) => /^[5-9]/.test(codeOf(row)))
    .reduce((total, row) => total + row.credit - row.debit, 0);
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

function addReportValue(rows: ReportRow[], code: string, side: "current" | "prior", amount: number, formulaNote: string) {
  const row = rows.find((item) => item.code === code);
  if (!row || !Number.isFinite(amount) || Math.abs(amount) <= 1) return;
  row[side] = Number(row[side] || 0) + amount;
  row.formula = row.formula ? `${row.formula}; ${formulaNote}` : formulaNote;
}

function applyUnclosedProfitToB01(B01: ReportRow[], currentAdjustment: number, priorAdjustment: number) {
  addReportValue(B01, "420b", "current", currentAdjustment, "Kết quả chưa kết chuyển = số dư Có trừ Nợ của các tài khoản tạm thời loại 5-9");
  addReportValue(B01, "420", "current", currentAdjustment, "420b bao gồm kết quả chưa kết chuyển");
  addReportValue(B01, "400", "current", currentAdjustment, "420 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addReportValue(B01, "440", "current", currentAdjustment, "400 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addReportValue(B01, "420b", "prior", priorAdjustment, "Kết quả chưa kết chuyển = số dư Có trừ Nợ của các tài khoản tạm thời loại 5-9");
  addReportValue(B01, "420", "prior", priorAdjustment, "420b bao gồm kết quả chưa kết chuyển");
  addReportValue(B01, "400", "prior", priorAdjustment, "420 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
  addReportValue(B01, "440", "prior", priorAdjustment, "400 bao gồm lãi/lỗ chưa kết chuyển từ B02 lũy kế");
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
  issues.push({ severity: "info", title: "B09 cần hoàn thiện thủ công", detail: "B09 là bản thuyết minh hỗ trợ; người lập báo cáo phải bổ sung chính sách kế toán, cam kết, bên liên quan và các thuyết minh định tính trước khi phát hành." });
  issues.push({ severity: "info", title: "Nguồn công thức", detail: "Các dòng có sourceRef theo TT99; dòng cần split ngắn/dài hạn hoặc disclosure ngoài journal được đánh dấu manual mapping." });
  return issues;
}

function notes(B01: ReportRow[], B02: ReportRow[], B03: ReportRow[]): NoteSection[] {
  return [
    {
      title: "I. Đặc điểm hoạt động của doanh nghiệp",
      paragraphs: [
        "Các thông tin về sở hữu vốn, lĩnh vực kinh doanh, ngành nghề, cấu trúc doanh nghiệp và chính sách kế toán là thông tin định tính, cần kế toán nhập và rà soát.",
        "Ứng dụng chỉ tự điền các khoản mục có thể truy vết từ sổ nhật ký.",
      ],
    },
    {
      title: "V. Thông tin bổ sung cho các khoản mục trình bày trong Báo cáo tình hình tài chính",
      table: {
        columns: ["Chỉ tiêu", "Cuối năm", "Đầu năm", "Ghi chú"],
        rows: [
          ["Tiền và các khoản tương đương tiền", reportValue(B01, "110"), reportValue(B01, "110", "prior"), "Từ B01 mã 110"],
          ["Phải thu ngắn hạn của khách hàng", reportValue(B01, "131"), reportValue(B01, "131", "prior"), "Từ B01 mã 131"],
          ["Hàng tồn kho", reportValue(B01, "141"), reportValue(B01, "141", "prior"), "Từ B01 mã 141"],
          ["Nợ phải trả", reportValue(B01, "300"), reportValue(B01, "300", "prior"), "Từ B01 mã 300"],
        ],
      },
    },
    {
      title: "VI. Thông tin bổ sung cho Báo cáo kết quả hoạt động kinh doanh",
      table: {
        columns: ["Chỉ tiêu", "Năm nay", "Năm trước", "Ghi chú"],
        rows: [
          ["Doanh thu thuần", reportValue(B02, "10"), reportValue(B02, "10", "prior"), "Từ B02 mã 10"],
          ["Giá vốn hàng bán", reportValue(B02, "11"), reportValue(B02, "11", "prior"), "Từ B02 mã 11"],
          ["Lợi nhuận sau thuế", reportValue(B02, "60"), reportValue(B02, "60", "prior"), "Từ B02 mã 60"],
        ],
      },
    },
    {
      title: "VII. Thông tin bổ sung cho Báo cáo lưu chuyển tiền tệ",
      table: {
        columns: ["Chỉ tiêu", "Năm nay", "Năm trước", "Ghi chú"],
        rows: [
          ["Lưu chuyển tiền thuần từ HĐKD", reportValue(B03, "20"), reportValue(B03, "20", "prior"), "Từ B03 mã 20"],
          ["Lưu chuyển tiền thuần từ HĐĐT", reportValue(B03, "30"), reportValue(B03, "30", "prior"), "Từ B03 mã 30"],
          ["Lưu chuyển tiền thuần từ HĐTC", reportValue(B03, "40"), reportValue(B03, "40", "prior"), "Từ B03 mã 40"],
        ],
      },
    },
  ];
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
  const ytdB02 = buildLineReport(b02Lines, currentOperating, priorOperating, "period");
  const currentBalanceRows = currentBalance.length ? currentBalance : [...opening, ...current];
  const priorBalanceRows = priorBalance.length ? priorBalance : prior;
  applyUnclosedProfitToB01(B01, unclosedTemporaryResult(currentBalanceRows), unclosedTemporaryResult(priorBalanceRows));
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
