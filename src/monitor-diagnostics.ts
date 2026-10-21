import type { ContentBlock } from './bedrock.ts';

// Diagnostics contain fixed labels and validated metadata, never exception messages,
// response bodies, URLs, images, prompts, credentials or household/device identifiers.
export type DiagnosticAudit = (row: Record<string, unknown>) => void;
export type DiagnosticConverse = (
  content: ContentBlock[],
  onResponse?: (metadata: { status?: number; requestId?: string }) => void,
) => Promise<string>;
export type MonitorStage =
  'preflight' | 'guard' | 'read_wakes' | 'wake' | 'observe' | 'feed' | 'write_status' | 'wait';

function field(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null) return;
    // Ignore accessors. Diagnostic extraction must not invoke arbitrary error getters.
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return;
  }
}

export function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)
    ? value
    : undefined;
}

export function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

export function safeError(error: unknown) {
  let errorClass = 'NonError';
  try {
    if (error instanceof TypeError) errorClass = 'TypeError';
    else if (error instanceof SyntaxError) errorClass = 'SyntaxError';
    else if (error instanceof RangeError) errorClass = 'RangeError';
    else if (error instanceof Error) errorClass = 'Error';
    if (error instanceof DOMException) {
      const name = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(
        error,
      );
      if (name === 'AbortError' || name === 'TimeoutError') errorClass = name;
    }
  } catch {
    // Proxies and hostile exception objects are reduced to fixed labels.
  }
  const name = field(error, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') errorClass = name;
  const status = safeHttpStatus(field(error, 'status'));
  const requestId = safeRequestId(field(error, 'requestId'));
  const code = field(error, 'code');
  const category =
    errorClass === 'TimeoutError'
      ? 'timeout'
      : errorClass === 'AbortError'
        ? 'cancelled'
        : status !== undefined && status >= 400
          ? 'http'
          : errorClass === 'SyntaxError'
            ? 'parse'
            : typeof code === 'string' &&
                ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
              ? 'network'
              : errorClass === 'NonError'
                ? 'unknown'
                : 'runtime';
  return {
    error_class: errorClass,
    error_category: category,
    ...(status === undefined ? {} : { http_status: status }),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255
      ? { exit_code: code }
      : {}),
  };
}

export function diagnostic(audit: DiagnosticAudit, row: Record<string, unknown>) {
  try {
    audit(row);
  } catch {
    // A failed diagnostic sink must not replace the original fault or block cleanup.
  }
}

export async function stopForRuntimeFault(
  monitor: { stop: (reason: string) => Promise<void> },
  audit: DiagnosticAudit,
  stage: MonitorStage,
  error: unknown,
  now = Date.now,
) {
  diagnostic(audit, {
    event: 'runtime_fault',
    stage,
    failed_at: now(),
    ...safeError(error),
  });
  await monitor.stop('source_or_runtime_fault');
}
