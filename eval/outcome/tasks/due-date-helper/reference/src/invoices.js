import { formatDate, formatMoney } from './format.js';

export function issuedLine(invoice) {
  return `Invoice ${invoice.id} issued ${formatDate(invoice.issuedAt)}`;
}

export function totalLine(invoice) {
  return `Invoice ${invoice.id} total ${formatMoney(invoice.totalCents, invoice.currency)}`;
}

// Customer-facing dates are the UTC calendar day; formatDate uses server local time.
export function dueLine(invoice) {
  return `Invoice ${invoice.id} due ${invoice.dueAt.toISOString().slice(0, 10)}`;
}
