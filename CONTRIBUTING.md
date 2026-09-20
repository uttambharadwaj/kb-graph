# Contributing to kb-graph

Contributions and AI-assisted contributions are welcome. Human contributors
remain responsible for reviewing generated code, protecting private data, and
verifying the result.

## Issues, support, and security

GitHub Issues are the project's support and Q&A channel as well as its bug and
feature tracker. Choose the matching issue template and include a minimal,
redacted reproduction. GitHub Discussions are deliberately disabled.

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in the [security policy](SECURITY.md).

The repository currently uses these labels:

- `bug` — confirmed or reproducible defects
- `documentation` — documentation changes
- `enhancement` — features and improvements
- `question` — support and Q&A
- `good first issue` — approachable contributions
- `help wanted` — work where maintainer or community help is requested
- `agent-task` — tasks with context and acceptance criteria for coding agents

## Contribution workflow

1. Fork and clone `kb-graph`.
2. Create a focused feature branch.
3. Read [llms.txt](llms.txt) and, for extension work,
   [EXTENDING.md](EXTENDING.md).
4. Make the change and add or update tests.
5. Run `npm test`.
6. Open a pull request describing the reason for the change and the
   verification performed.

Pull requests should preserve existing MCP interfaces unless the change
explicitly coordinates a breaking release. Follow the existing ES module and
async/await patterns. Never commit credentials, local vault content, generated
`.env` files, or machine-specific paths.

## Community Guidelines

- Be respectful and constructive
- Share what you learn — if your AI found a better approach, document it
- Credit your tools — it's cool to say "Claude helped me write this"
- Review before submitting — AI writes fast but human judgment catches edge cases
- Ask questions — open an issue if you're unsure about architecture decisions

## Development Setup

Requirements:

- macOS or Linux
- Node.js 22, 24, or 26
- an installed, authenticated `claude` CLI for AI-backed curation paths

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm ci
node bin/kb.js setup
node bin/kb.js status
npm test
```

`npm link` is optional if you prefer the shorter `kb ...` commands while
developing.

Agents connect via `kb mcp-shim` (what `kb register` writes): a byte pipe to
the resident `kb serve` daemon when one is running, a full in-process server
when none is. See [docs/daemon-setup.md](docs/daemon-setup.md).

While developing, mind which process serves your code:

- **Daemon running:** it deliberately does not watch `src/` — restart it after
  edits (`launchctl kickstart -k gui/$(id -u)/com.kb.serve` /
  `systemctl --user restart kb-serve`) or your changes are served by nothing.
- **No daemon (in-process fallback / direct `kb mcp`):** `kb mcp` is a
  supervisor — it holds the client's stdio connection and runs the real server
  (`src/mcp.js`) as a child, replacing that child whenever a `.js` or `.json`
  file under `src/` changes and no tool call is in flight. Edit, save, and the
  next call is served by the new code. Three changes still need a real
  reconnect: `src/mcp-supervisor.js` or `src/restart-on-change.js` themselves
  (only the child is replaced); the server's declared capabilities, pinned by
  the first child's `initialize` response; and `.env`, which `bin/kb.js` reads
  once at startup. Code reloads, configuration does not.

`kb stale-servers` lists running servers that predate their own checkout's last
source change — the ones that will never notice on their own.

Run `npm test` before opening a pull request.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
