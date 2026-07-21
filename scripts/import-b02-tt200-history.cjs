const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const XLSX = require("xlsx");
const { convertTt200Month } = require("../server/b02-history.cjs");

dotenv.config({ quiet: true });

function parsePeriodFromFileName(filePath) {
  const name = path.basename(filePath);
  const match = /T(0?[1-9]|1[0-2])(\d{2})\.xls$/i.exec(name);
  if (!match) throw new Error(`Cannot identify month/year from file name: ${name}`);
  return { fiscalMonth: Number(match[1]), fiscalYear: 2000 + Number(match[2]) };
}

function numericCell(value, code, fileName) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  throw new Error(`${fileName}: TT200 line ${code} does not have a numeric 'Năm nay' value`);
}

function readMonthlyReport(filePath) {
  const { fiscalYear, fiscalMonth } = parsePeriodFromFileName(filePath);
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellDates: true });
  if (workbook.SheetNames.length !== 1) throw new Error(`${path.basename(filePath)}: expected one sheet`);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const source = new Map();
  rows.forEach((row, rowIndex) => {
    const code = String(row[1] ?? "").trim();
    if (!code || code === "2" || code.toLowerCase() === "mã số") return;
    const currentValue = row[3];
    if (currentValue === null || currentValue === "") return;
    source.set(code, {
      amount: numericCell(currentValue, code, path.basename(filePath)),
      cell: XLSX.utils.encode_cell({ r: rowIndex, c: 3 }),
    });
  });

  const mapped = convertTt200Month(source);
  const bytes = fs.readFileSync(filePath);
  const sourceFileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return mapped.map((row) => ({
    ...row,
    fiscalYear,
    fiscalMonth,
    sourceFileName: path.basename(filePath),
    sourceFileSha256,
    sourceSheetName: sheetName,
  }));
}

function validateCompleteYear(rows) {
  const years = new Set(rows.map((row) => row.fiscalYear));
  if (years.size !== 1) throw new Error(`Expected one fiscal year, got: ${[...years].join(", ")}`);
  const months = new Set(rows.map((row) => row.fiscalMonth));
  const missing = Array.from({ length: 12 }, (_, index) => index + 1).filter((month) => !months.has(month));
  if (missing.length || months.size !== 12) throw new Error(`Expected months 1-12 exactly once; missing: ${missing.join(", ") || "none"}`);
  const keys = new Set();
  for (const row of rows) {
    const key = `${row.fiscalYear}-${row.fiscalMonth}-${row.targetLineCode}`;
    if (keys.has(key)) throw new Error(`Duplicate mapped row: ${key}`);
    keys.add(key);
  }
}

async function upsertRows(rows) {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    const migration = fs.readFileSync(path.join(__dirname, "..", "server", "migrations", "007_b02_historical_monthly_values.sql"), "utf8");
    await client.query(migration);

    const columnsPerRow = 13;
    const values = [];
    const tuples = rows.map((row, rowIndex) => {
      const offset = rowIndex * columnsPerRow;
      values.push(
        row.fiscalYear,
        row.fiscalMonth,
        row.targetLineCode,
        row.targetLineName,
        row.amount,
        row.valueStatus,
        "TT200",
        row.sourceLineCodes,
        row.sourceCells,
        row.mappingRule,
        row.sourceFileName,
        row.sourceFileSha256,
        row.sourceSheetName,
      );
      return `(${Array.from({ length: columnsPerRow }, (_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await client.query(
      `insert into public.b02_historical_monthly_values (
         fiscal_year, fiscal_month, target_line_code, target_line_name, amount,
         value_status, source_standard, source_line_codes, source_cells, mapping_rule,
         source_file_name, source_file_sha256, source_sheet_name
       ) values ${tuples.join(", ")}
       on conflict (fiscal_year, fiscal_month, target_line_code) do update set
         target_line_name = excluded.target_line_name,
         amount = excluded.amount,
         value_status = excluded.value_status,
         source_standard = excluded.source_standard,
         source_line_codes = excluded.source_line_codes,
         source_cells = excluded.source_cells,
         mapping_rule = excluded.mapping_rule,
         source_file_name = excluded.source_file_name,
         source_file_sha256 = excluded.source_file_sha256,
         source_sheet_name = excluded.source_sheet_name,
         imported_at = now()`,
      values,
    );
    const audit = await client.query(
      `select fiscal_year as year, count(*)::int as rows,
              count(distinct fiscal_month)::int as months,
              count(*) filter (where value_status = 'available')::int as available,
              count(*) filter (where value_status = 'unavailable')::int as unavailable
         from public.b02_historical_monthly_values
        where fiscal_year = $1
        group by fiscal_year`,
      [rows[0].fiscalYear],
    );
    await client.query("commit");
    return audit.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length !== 12) throw new Error(`Expected exactly 12 monthly .xls files, got ${files.length}`);
  const rows = files.flatMap(readMonthlyReport);
  validateCompleteYear(rows);
  const summaries = Array.from({ length: 12 }, (_, index) => index + 1).map((month) => {
    const monthRows = rows.filter((row) => row.fiscalMonth === month);
    return {
      month,
      rows: monthRows.length,
      available: monthRows.filter((row) => row.valueStatus === "available").length,
      unavailable: monthRows.filter((row) => row.valueStatus === "unavailable").length,
      revenue01: monthRows.find((row) => row.targetLineCode === "01")?.amount,
      netProfit60: monthRows.find((row) => row.targetLineCode === "60")?.amount,
    };
  });
  console.table(summaries);
  if (!apply) {
    console.log("Dry run passed; database was not changed.");
    return;
  }
  const audit = await upsertRows(rows);
  console.log("Imported B02 history:", audit);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parsePeriodFromFileName, readMonthlyReport, validateCompleteYear };
