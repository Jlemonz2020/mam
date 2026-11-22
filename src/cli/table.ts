/** 简易控制台表格 */
export function printTable(headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => cell(r[i]).length))
  );
  const line = (cells: Array<string | number | null | undefined>, pad = ' ') =>
    '| ' + cells.map((c, i) => cell(c)[pad === '-' ? 'padStart' : 'padEnd'](widths[i], pad === '-' ? ' ' : pad)).join(' | ') + ' |';
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  console.log(sep);
  console.log(line(headers));
  console.log(sep);
  for (const row of rows) console.log(line(row));
  console.log(sep);
}
