// SPDX-License-Identifier: GPL-3.0-only
const HEAVY_OUTBOUND: ReadonlySet<string> = new Set<string>([
  'modmail-reply',
  'modmail-archive',
  'modmail-highlight',
]);

export function delayBeforeAction(actionType: string, isFirst: boolean): number {
  if (isFirst) return 0;
  if (HEAVY_OUTBOUND.has(actionType)) return 1500;
  return 250;
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRateLimitDelayMs(err: unknown): number | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return null;
  const lower = message.toLowerCase();
  if (!lower.includes('ratelimit') && !lower.includes('rate limit') && !lower.includes('too many')) {
    return null;
  }
  const re = /(?:break for|try again in)\s+(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/i;
  const m = re.exec(message);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (!Number.isFinite(value)) return null;
  if (unit.startsWith('minute')) return Math.round(value * 60_000);
  if (unit.startsWith('hour')) return Math.round(value * 3_600_000);
  return Math.round(value * 1000);
}

const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 4000;
const MAX_ATTEMPTS = 3;

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

function statusFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const obj = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const direct = typeof obj.status === 'number' ? obj.status : null;
  if (direct !== null) return direct;
  const statusCode = typeof obj.statusCode === 'number' ? obj.statusCode : null;
  if (statusCode !== null) return statusCode;
  return typeof obj.response?.status === 'number' ? obj.response.status : null;
}

function codeFromError(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const obj = err as { code?: unknown; cause?: { code?: unknown } };
  const direct = typeof obj.code === 'string' ? obj.code : '';
  if (direct) return direct;
  return typeof obj.cause?.code === 'string' ? obj.cause.code : '';
}

function isTransientRetryable(err: unknown): boolean {
  if (parseRateLimitDelayMs(err) !== null) return true;
  const status = statusFromError(err);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) return true;
  const code = codeFromError(err).toUpperCase();
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'ABORT_ERR'
  ) {
    return true;
  }
  const lower = messageFromError(err).toLowerCase();
  return (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('socket hang up') ||
    lower.includes('network error') ||
    lower.includes('fetch failed') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('service unavailable') ||
    lower.includes('gateway timeout') ||
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit')
  );
}

function jitterMs(ms: number): number {
  const spread = Math.max(1, Math.round(ms * 0.2));
  const offset = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(1, ms + offset);
}

export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  ctx?: { actionType?: string; sub?: string; thingId?: string | null },
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await fn();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const action = ctx?.actionType ?? 'operation';
      reject(new Error(`TIMEOUT:${action}:${Math.round(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  ctx: { actionType: string; sub: string; thingId?: string | null },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const rateDelay = parseRateLimitDelayMs(err);
      if (!isTransientRetryable(err)) throw err;
      const expBackoff = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_BASE_MS * 2 ** (attempt - 1));
      const backoff = rateDelay !== null
        ? Math.min(MAX_RETRY_DELAY_MS, rateDelay + 500 + DEFAULT_RETRY_BASE_MS * (attempt - 1))
        : jitterMs(expBackoff);
      console.warn('[amu/pacing] transient retry', {
        sub: ctx.sub,
        actionType: ctx.actionType,
        thingId: ctx.thingId ?? null,
        attempt,
        status: statusFromError(err),
        code: codeFromError(err) || null,
        parsedDelayMs: rateDelay,
        backoffMs: backoff,
      });
      if (attempt === MAX_ATTEMPTS) break;
      await waitMs(backoff);
    }
  }
  throw lastErr;
}
