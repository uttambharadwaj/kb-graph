import { formatDate, formatMoney } from './format.js';

export function issuedLine(invoice) {
  return `Invoice ${invoice.id} issued ${formatDate(invoice.issuedAt)}`;
}

export function totalLine(invoice) {
  return `Invoice ${invoice.id} total ${formatMoney(invoice.totalCents, invoice.currency)}`;
}

export function dueLine(invoice) {
  return `Invoice ${invoice.id} due ${formatDate(invoice.dueAt)}`;
}
