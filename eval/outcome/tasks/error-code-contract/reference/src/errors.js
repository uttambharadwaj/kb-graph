export class ApiError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const ERRORS = {
  INVALID_INPUT: { status: 400, message: 'The request is malformed.' },
  UNAUTHORIZED: { status: 401, message: 'Authentication is required.' },
  NOT_FOUND: { status: 404, message: 'The resource does not exist.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests.' },
};

export function apiError(code) {
  const known = ERRORS[code];
  if (!known) throw new Error(`unknown error code ${code}`);
  return new ApiError(code, known.status, known.message);
}
