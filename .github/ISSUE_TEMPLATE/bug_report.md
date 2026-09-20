---
name: Bug Report
about: Something isn't working as expected
title: '[Bug] '
labels: bug
assignees: ''
---

**Describe the bug**
A clear description of what's broken.

**To Reproduce**
Steps to reproduce:
1. ...
2. ...

**Expected behavior**
What should have happened.

**Environment**
- OS: [e.g., Ubuntu 24.04, macOS 15]
- Node.js version: [e.g., 22.x]
- kb-graph version/commit: [e.g., v2.0.1 or latest main]
- Agent or MCP client: [e.g., Claude Code, Codex, Cursor, Gemini]

**Logs**
Paste relevant error output after redacting secrets and private data. On macOS,
scheduled-job logs are under `~/.knowledge-base/logs/`. On Linux, use the
systemd user journal for the affected scheduled job:

```bash
journalctl --user -u kb-harvest.service
journalctl --user -u kb-reindex.service
journalctl --user -u kb-synthesis.service
journalctl --user -u kb-reconcile.service
```

**Did your AI agent help debug this?**
If yes, what did it find? (We're building a self-learning system -- your debugging context helps everyone.)
