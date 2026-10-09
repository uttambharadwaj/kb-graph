export function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}
