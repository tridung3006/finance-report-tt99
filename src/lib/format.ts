export function formatMoney(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "";
  const abs = Math.abs(Math.round(value));
  const text = new Intl.NumberFormat("vi-VN").format(abs);
  return value < 0 ? `(${text})` : text;
}

export function sum(values: Array<number | null | undefined>) {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function toPlainNumber(value: number | null | undefined) {
  return value == null || Number.isNaN(value) ? "" : Math.round(value);
}
