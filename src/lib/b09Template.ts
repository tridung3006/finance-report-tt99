import templateSchema from "../../server/tt99-template-schema.json";
import type { NoteSection, NoteValue, ReportRow } from "../types/finance";

type ReportKey = "B01" | "B02" | "B03";
type SourceBlock =
  | { type: "paragraph"; text: string }
  | {
      type: "table";
      table: {
        templateIndex: number;
        title: string;
        columnCount: number;
        rowCount: number;
        rows: NoteValue[][];
      };
    };

const summaryMappings = new Map<number, [ReportKey, string[]]>([
  [1, ["B01", ["110"]]],
  [17, ["B01", ["161", "271"]]],
  [18, ["B01", ["165", "274"]]],
  [23, ["B01", ["311", "331"]]],
  [24, ["B01", ["313"]]],
  [26, ["B01", ["316", "334"]]],
  [27, ["B01", ["320", "338"]]],
  [28, ["B01", ["319", "337"]]],
  [37, ["B01", ["416"]]],
  [38, ["B01", ["417"]]],
  [41, ["B02", ["01"]]],
  [42, ["B02", ["02"]]],
  [43, ["B02", ["11"]]],
  [44, ["B02", ["21"]]],
  [45, ["B02", ["22"]]],
  [46, ["B02", ["23"]]],
  [47, ["B02", ["31"]]],
  [48, ["B02", ["32"]]],
  [49, ["B02", ["25", "26"]]],
  [51, ["B02", ["51", "52"]]],
]);

function reportSum(report: ReportRow[], codes: string[], side: "current" | "prior") {
  const values = codes.map((code) => report.find((row) => row.code === code)?.[side] ?? null);
  return values.every((value) => value == null)
    ? null
    : values.reduce<number>((total, value) => total + Number(value || 0), 0);
}

export function buildB09FromTemplate(B01: ReportRow[], B02: ReportRow[], B03: ReportRow[]): NoteSection[] {
  const reports: Record<ReportKey, ReportRow[]> = { B01, B02, B03 };
  const sections = templateSchema.B09.sections as Array<{ title: string; blocks: SourceBlock[] }>;

  return sections.map((sourceSection) => ({
    title: sourceSection.title,
    blocks: sourceSection.blocks.map((sourceBlock) => {
      if (sourceBlock.type === "paragraph") return { ...sourceBlock };

      const sourceTable = sourceBlock.table;
      const templateRows = sourceTable.rows.map((row) => [...row]);
      const mapping = summaryMappings.get(sourceTable.templateIndex);
      if (mapping && sourceTable.columnCount === 3) {
        const [reportId, codes] = mapping;
        const target = templateRows.length - 1;
        templateRows[target][1] = reportSum(reports[reportId], codes, "current");
        templateRows[target][2] = reportSum(reports[reportId], codes, "prior");
      }

      return {
        type: "table" as const,
        table: {
          templateIndex: sourceTable.templateIndex,
          title: sourceTable.title,
          columnCount: sourceTable.columnCount,
          sourceRowCount: sourceTable.rowCount,
          templateRows,
          columns: templateRows[0].map((value) => value == null ? "" : String(value)),
          rows: templateRows.slice(1),
        },
      };
    }),
  }));
}

export const tt99TemplateSchema = templateSchema;
