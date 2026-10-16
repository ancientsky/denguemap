// CSV generation (RFC 4180) with a spreadsheet formula-injection guard.

const FORMULA_START = /^[=+\-@\t\r]/;

/** Escape one cell: neutralise leading = + - @ (and tab/CR) with a single quote, then quote if needed. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  // Plain numbers (incl. negatives) are data, not formulas — keep them numeric.
  if (FORMULA_START.test(s) && !(typeof value === 'number')) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** UTF-8 BOM so Excel opens Chinese text correctly. */
export const BOM = '﻿';

export function csvBlob(rows: readonly (readonly unknown[])[]): Blob {
  return new Blob([BOM + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
