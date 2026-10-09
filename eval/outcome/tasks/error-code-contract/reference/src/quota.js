import { apiError } from './errors.js';

export function checkQuota(account) {
  if (!account) throw apiError('INVALID_INPUT');
  if (account.requestsThisMinute >= account.limitPerMinute) throw apiError('RATE_LIMITED');
  return true;
}
