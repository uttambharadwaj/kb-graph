// Reproduces a real incident: a src-reaching import listed before
// tests/helpers/tmp-kb.js resolves KB_DIR before the helper can set it.
// Not picked up by `node --test tests/*.test.js` — run directly via child_process.
import '../../src/paths.js';
import '../helpers/tmp-kb.js';
