#!/bin/bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo v22.22.1)/bin:/usr/local/bin:/usr/bin:$PATH"
KB_DIR="${KB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -f "$KB_DIR/.env" ]; then set -a; source "$KB_DIR/.env"; set +a; fi
cd "$KB_DIR"
node bin/weekly-synthesis.js
