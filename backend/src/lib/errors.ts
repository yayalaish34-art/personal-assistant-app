export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class Unauthorized extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}

export class Forbidden extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class NotFound extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class Conflict extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class RateLimited extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    retryAfterSeconds?: number,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class PayloadTooLarge extends AppError {
  readonly statusCode = 413;
  readonly code = 'PAYLOAD_TOO_LARGE';
}

export class UnsupportedMedia extends AppError {
  readonly statusCode = 415;
  readonly code = 'UNSUPPORTED_MEDIA';
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
