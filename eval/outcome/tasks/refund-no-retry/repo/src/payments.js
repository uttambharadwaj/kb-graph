import { fetchJson } from './http.js';

export async function getOrder(orderId) {
  return fetchJson(`/orders/${orderId}`);
}

export async function listCharges(orderId) {
  return fetchJson(`/orders/${orderId}/charges`);
}

export async function capturePayment(orderId) {
  return fetchJson(`/orders/${orderId}/capture`, { method: 'POST' });
}
