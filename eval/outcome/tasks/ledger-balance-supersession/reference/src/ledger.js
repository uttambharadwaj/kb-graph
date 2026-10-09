import { get } from './ledger-client.js';

const toCents = amount => Math.round(Number(amount) * 100);

export async function listBalances(accountIds) {
  const rows = await get(`/v1/balances?accounts=${accountIds.join(',')}`);
  return rows.map(row => ({ accountId: row.account, availableCents: toCents(row.available) }));
}

export async function getAvailableBalance(accountId) {
  const { availableCents } = await get(`/v2/accounts/${accountId}/balance`);
  return availableCents;
}
