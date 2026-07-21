const ACCOUNTING_TIME_ZONE = "Asia/Ho_Chi_Minh";

export function normalizeDateOnly(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ACCOUNTING_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || String(value);
}
