import pg from 'pg';

const { Pool, types } = pg;

// DATE 列按字符串返回（YYYY-MM-DD），避免被转成带时区的 Date 对象
types.setTypeParser(types.builtins.DATE, (value: string | null) => value);

// NUMERIC 列直接解析为 number（评分/均分均在安全范围内）
types.setTypeParser(types.builtins.NUMERIC, (value: string | null) =>
  value === null ? null : Number(value),
);

export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'sangha',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
});

export interface DTO {
  [k: string]: unknown;
}

export async function one<T = DTO>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return rows[0] as T;
}

export async function many<T = DTO>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// 枚举参数白名单校验，避免非法值导致 500
export function asEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new ApiError(400, `无效的${label}：${String(value)}`);
}

export const MONK_STATUSES = ['guadan', 'inspection', 'permanent', 'left'] as const;
export const GUADAN_STATUSES = ['active', 'closed'] as const;
export const INSPECTION_RESULTS = ['pending', 'passed', 'failed'] as const;
export const ALERT_STATUSES = ['open', 'acknowledged'] as const;
export const ROUND_STATUSES = ['collecting', 'summarized'] as const;
export const SUBMISSION_TYPES = ['normal', 'makeup'] as const;
export const REVIEW_CONCLUSIONS = ['excellent', 'qualified', 'unqualified'] as const;
