import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(
  code: string,
  message: string,
  status: ContentfulStatusCode = 400,
  details?: unknown,
): { status: ContentfulStatusCode; body: ApiError } {
  return { status, body: { error: { code, message, details } } };
}

/** Turns a ZodError-shaped issue list into a 422 with field-level detail. */
export function validationError(issues: readonly { path: PropertyKey[]; message: string }[]) {
  return apiError(
    'invalid_request',
    'Request body failed validation',
    422,
    issues.map((issue) => ({
      field: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  );
}
