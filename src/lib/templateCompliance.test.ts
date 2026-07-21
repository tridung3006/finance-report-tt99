import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { b01Lines, b03Lines } from "../config/templates";
import type { GeneratedReports, PeriodMeta, ReportRow } from "../types/finance";
import { buildB09FromTemplate, tt99TemplateSchema } from "./b09Template";
import { createOfficialWorkbook, officialAoaForReport, qaAoaForReport } from "./exporters";

function sha(value: unknown) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const templateHashes = {
  "b01-dn.docx": "3ab606a45f59ce43c6939537ae53fe6da4ad7d4ec17245e938bbb4ff0a6f4393",
  "b03-dn-truc-tiep.docx": "d7dfba4d4a460364c3635e3fd1bf3efc322dff1efc799daecee79ffd12a7cc4c",
  "b09-dn.docx": "ae2b191cffc262dfaf24804cac4c0fcda259cd275cf9d4a79c6a0394bb456a61",
};

for (const [name, expected] of Object.entries(templateHashes)) {
  const path = fileURLToPath(new URL(`../../templates/tt99/${name}`, import.meta.url));
  assert(sha(readFileSync(path)) === expected, `${name} no longer matches the approved source DOCX`);
}

const actualB01 = b01Lines.map(({ code, label }) => ({ code, label }));
const actualB03 = b03Lines.filter(({ code }) => code).map(({ code, label }) => ({ code, label }));
assert(JSON.stringify(actualB01) === JSON.stringify(tt99TemplateSchema.B01), "B01 codes, names or order differ from the approved DOCX");
assert(JSON.stringify(actualB03) === JSON.stringify(tt99TemplateSchema.B03), "B03 codes, names or order differ from the approved DOCX");
assert(sha(actualB01) === "12062fbb898b0234e367abc4fd88a15f94ae6255f335a27d6a4492c3858dad2f", "B01 statutory fingerprint changed");
assert(sha(actualB03) === "e9015265aaa75664e3d3e1163a88121d450b4ccdfe7a87c433fc5aa76088c55d", "B03 statutory fingerprint changed");

const B09 = buildB09FromTemplate([], [], []);
const tables = B09.flatMap((section) => section.blocks?.filter((block) => block.type === "table").map((block) => block.table) ?? []);
assert(tables.length === 53, `B09 must contain 53 content tables, got ${tables.length}`);
assert(tables.every((table, index) => table.templateIndex === index + 1), "B09 table order/index is not contiguous from 1 to 53");
assert(tables.every((table) => table.templateRows?.length === table.sourceRowCount), "B09 source row count differs from the DOCX");
assert(tables.every((table) => table.templateRows?.every((row) => row.length === table.columnCount)), "B09 source column grid differs from the DOCX");

const structure = tables.map((table) => [table.templateIndex, table.sourceRowCount, table.columnCount, table.title]);
assert(sha(structure) === "bd441b51788e8cc3664d1e09c5a4359d3a209261e1182a2d2aa037ac1d9b917a", "B09 code/order/title/row/column structure changed");
assert(sha(structure.map((item) => item[3])) === "2cc22c6ded2ecfff684b33de486c57ac3bb24e4d6894b5beb98f4bb819896c01", "B09 table titles changed");
assert(sha(structure.map((item) => item.slice(0, 3))) === "fd706347c91b14304fd8ac2cf1228789c6a6120e7095e1ce65555e07af993b93", "B09 table count/order/dimensions changed");

const columnDistribution = tables.reduce<Record<number, number>>((result, table) => {
  const columns = table.columnCount ?? 0;
  result[columns] = (result[columns] ?? 0) + 1;
  return result;
}, {});
assert(JSON.stringify(columnDistribution) === JSON.stringify({ 3: 31, 5: 12, 6: 2, 7: 7, 10: 1 }), "B09 column distribution differs from the DOCX");

const require = createRequire(import.meta.url);
const serverB09 = require("../../server/b09-template.cjs").buildB09FromTemplate({ B01: [], B02: [], B03: [] });
const serverStructure = serverB09.flatMap((section: { blocks: Array<{ type: string; table?: typeof tables[number] }> }) =>
  section.blocks.filter((block) => block.type === "table").map((block) => [block.table?.templateIndex, block.table?.sourceRowCount, block.table?.columnCount, block.table?.title]),
);
assert(sha(serverStructure) === "bd441b51788e8cc3664d1e09c5a4359d3a209261e1182a2d2aa037ac1d9b917a", "Server B09 structure differs from the approved DOCX");
const serverReports = require("../../server/index.cjs");
assert(JSON.stringify(serverReports.b01Lines.map((line: unknown[]) => ({ code: line[0], label: line[1] }))) === JSON.stringify(tt99TemplateSchema.B01), "Server B01 codes, names or order differ from the approved DOCX");
assert(JSON.stringify(serverReports.b03Lines.filter((line: unknown[]) => line[0]).map((line: unknown[]) => ({ code: line[0], label: line[1] }))) === JSON.stringify(tt99TemplateSchema.B03), "Server B03 codes, names or order differ from the approved DOCX");

const sampleRows: ReportRow[] = [{ label: "Dòng mẫu", code: "01", note: "TM", current: 1, prior: 2, level: 0, formula: "A+B", requiresManualMapping: true }];
const officialHeader = officialAoaForReport(sampleRows, "CHỈ TIÊU", "Năm nay", "Năm trước")[0];
const qaHeader = qaAoaForReport(sampleRows, "CHỈ TIÊU", "Năm nay", "Năm trước")[0];
assert(officialHeader.length === 5 && !officialHeader.includes("Công thức") && !officialHeader.includes("Cần mapping thủ công"), "Official report export leaks QA columns");
assert(qaHeader.includes("Công thức") && qaHeader.includes("Cần mapping thủ công"), "QA report export lost its audit columns");

const reports: GeneratedReports = { B01: sampleRows, B02: sampleRows, B03: sampleRows, B09, validations: [], unclassifiedCashRows: [], cashMovements: [] };
const meta: PeriodMeta = { companyName: "Test", address: "", taxCode: "", year: "2026", startDate: "2026-01-01", endDate: "2026-12-31", currency: "VND", preparedDate: "" };
const workbook = createOfficialWorkbook(reports, meta);
assert(JSON.stringify(workbook.SheetNames) === JSON.stringify(["Thông tin", "B01", "B02", "B03", "B09"]), "Official workbook contains QA/source sheets");
for (const sheetName of ["B01", "B02", "B03"]) {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1 });
  assert(rows[0]?.length === 5, `${sheetName} official sheet must have exactly five statutory columns`);
}

console.log("TT99 template compliance tests passed");
