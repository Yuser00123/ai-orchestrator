export class OrchestratorError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends OrchestratorError {
  constructor(message: string) {
    super('invalid_request', message, 400);
    this.name = 'ValidationError';
  }
}

export class AuthError extends OrchestratorError {
  constructor(message = 'invalid or missing orchestrator key') {
    super('unauthorized', message, 401);
    this.name = 'AuthError';
  }
}

export class RateLimitedError extends OrchestratorError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = 'rate limited') {
    super('rate_limited', message, 429);
    this.name = 'RateLimitedError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class PolicyDeniedError extends OrchestratorError {
  constructor(reason: string) {
    super('policy_denied', `blocked by policy: ${reason}`, 403);
    this.name = 'PolicyDeniedError';
  }
}

/** Transient = worth retrying (gateway warming/restarting, provider failover in progress). */
export class GatewayError extends OrchestratorError {
  readonly retryable: boolean;
  readonly gatewayCode: string;
  constructor(message: string, status: number, retryable: boolean, gatewayCode = 'gateway_error') {
    super('gateway_error', message, 502);
    this.name = 'GatewayError';
    this.retryable = retryable;
    this.gatewayCode = gatewayCode;
  }
}

export function toPublicError(err: unknown): { code: string; message: string; status: number } {
  if (err instanceof OrchestratorError) {
    return { code: err.code, message: err.message, status: err.status };
  }
  /* Fastify's own request-level failures must not surface as 500 (they are client errors). */
  const code = (err as { code?: string })?.code ?? '';
  if (code.startsWith('FST_ERR_CTP')) return { code: 'unsupported_media_type', message: 'Content-Type must be application/json', status: 415 };
  if (code === 'FST_ERR_VALIDATION' || code === 'FST_ERR_BODY_TOO_LARGE') return { code: 'invalid_request', message: 'body failed request validation', status: 400 };
  const msg = err instanceof Error ? err.message : String(err);
  return { code: 'internal_error', message: msg.slice(0, 400), status: 500 };
}
