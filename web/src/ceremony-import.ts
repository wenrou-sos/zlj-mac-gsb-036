// 表格粘贴/CSV 解析：支持 Tab（Excel 粘贴）、逗号分隔，支持引号包裹
export interface ParsedRow {
  [key: string]: string;
}

export function parseTable(text: string): { headers: string[]; rows: ParsedRow[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };

  const splitLine = (line: string): string[] => {
    const sep = line.includes('\t') ? '\t' : ',';
    const out: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === sep && !inQuote) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitLine(lines[0]);
  const rows: ParsedRow[] = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row: ParsedRow = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

export const IMPORT_TEMPLATE = [
  '法名\t出家寺庙\t戒牒编号\t到寺日期\t离寺日期\t特殊需求',
  '宗印\t五台山\tFH2026001\t2026-10-01\t2026-10-07\t腿脚不便，住低层',
  '海幢\t普陀山\tFH2026002\t2026-10-01\t2026-10-07\t',
].join('\n');
