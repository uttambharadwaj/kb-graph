import { request } from './http.js';

export async function getOrder(orderId) {
  return request(`/orders/${orderId}`);
}

export async function listCharges(orderId) {
  return request(`/orders/${orderId}/charges`);
}

export async function capturePayment(orderId) {
  return request(`/orders/${orderId}/capture`, { method: 'POST' });
}
