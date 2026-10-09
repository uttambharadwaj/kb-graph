const pad = n => String(n).padStart(2, '0');

export function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatMoney(cents, currency = 'USD') {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
