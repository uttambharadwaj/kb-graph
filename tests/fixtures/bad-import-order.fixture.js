// Regression fixture for the KB_DIR guard (kb lesson #3519): reproduces the
// incident shape by listing a src-reaching import before tests/helpers/tmp-kb.js.
// Not picked up by `node --test tests/*.test.js` — run directly via child_process.
import '../../src/paths.js';
import '../helpers/tmp-kb.js';
