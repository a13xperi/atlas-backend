type PaginationQuery = {
  limit?: unknown;
  offset?: unknown;
};

type PaginationDefaults = {
  limit?: number;
  offset?: number;
};

const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;

function readInteger(value: unknown): number | null {
  if (Array.isArray(value)) {
    return readInteger(value[0]);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function clampLimit(limit: number): number {
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit));
}

function clampOffset(offset: number): number {
  return Math.max(DEFAULT_OFFSET, offset);
}

export function parsePagination(
  query: PaginationQuery,
  defaults: PaginationDefaults = {},
): { take: number; skip: number } {
  const defaultTake = clampLimit(readInteger(defaults.limit) ?? DEFAULT_LIMIT);
  const defaultSkip = clampOffset(readInteger(defaults.offset) ?? DEFAULT_OFFSET);

  const take = clampLimit(readInteger(query.limit) ?? defaultTake);
  const skip = clampOffset(readInteger(query.offset) ?? defaultSkip);

  return { take, skip };
}
