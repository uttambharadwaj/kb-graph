// Canonical names for maintenance tools that can satisfy a capture checkpoint.
// Tool registration, fallback routing, and reporting all import this vocabulary.
export const MAINTENANCE_TOOL = Object.freeze({
  WRITE: 'kb_write',
  CAPTURE_FIX: 'kb_capture_fix',
  SUPERSEDE: 'kb_supersede',
  PROMOTE: 'kb_promote',
});
