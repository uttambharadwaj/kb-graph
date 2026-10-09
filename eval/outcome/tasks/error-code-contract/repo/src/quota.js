import { apiError } from './errors.js';

export function checkQuota(account) {
  if (!account) throw apiError('INVALID_INPUT');
  return true;
}
