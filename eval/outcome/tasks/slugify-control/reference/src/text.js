export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function slugify(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
