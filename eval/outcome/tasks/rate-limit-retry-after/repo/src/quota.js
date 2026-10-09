import { apiError } from './errors.js';

export function checkQuota(account, now = new Date()) {
  if (!account) throw apiError('INVALID_INPUT');
  return true;
}
