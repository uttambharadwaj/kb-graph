import { formatDate } from './vendor/legacy-dates.js';

export function issuedLine(invoice) {
  return `Invoice ${invoice.id} issued ${formatDate(invoice.issuedAt)}`;
}

export function paidLine(invoice) {
  return `Invoice ${invoice.id} paid ${formatDate(invoice.paidAt)}`;
}

export function dueLine(invoice) {
  return `Invoice ${invoice.id} due ${formatDate(invoice.dueAt)}`;
}
