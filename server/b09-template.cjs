const templateSchema = require("./tt99-template-schema.json");

const summaryMappings = new Map([
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

function reportSum(report, codes, side) {
  const values = codes.map((code) => report.find((row) => row.code === code)?.[side] ?? null);
  return values.every((value) => value == null)
    ? null
    : values.reduce((total, value) => total + Number(value || 0), 0);
}

function buildB09FromTemplate(reports) {
  return templateSchema.B09.sections.map((sourceSection) => ({
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
        type: "table",
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

module.exports = {
  buildB09FromTemplate,
  templateSchema,
};
