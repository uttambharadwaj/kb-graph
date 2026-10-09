import { test } from 'node:test';
import assert from 'node:assert';
import { issuedLine } from '../src/invoices.js';

test('issuedLine names the invoice', () => {
  assert.match(issuedLine({ id: 'inv-1', issuedAt: new Date('2026-03-01T12:00:00Z') }), /^Invoice inv-1 issued \d{4}-\d{2}-\d{2}$/);
});
