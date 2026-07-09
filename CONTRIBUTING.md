# Contributing to knowledge-base-server

We welcome contributions. This project is built by AI-augmented developers, for AI-augmented developers. Use your AI agents to help you contribute — that's the whole point.

## The Vision

This isn't just an open source project. It's a collectively evolving AI memory system. When you improve this codebase, every user's AI agents get smarter. When you add a new ingestion source, everyone's knowledge pipeline expands. We're building the context layer for AI together.

## How to Contribute

### The AI-First Contribution Pattern

1. Clone the repo
2. Tell your AI agent: "Read EXTENDING.md and llms.txt to understand this project"
3. Ask your agent: "How can we make this better?"
4. Let your agent analyze the codebase and propose improvements
5. Review the output (human judgment is the irreplaceable element)
6. Submit a PR

We encourage AI-assisted contributions. If your agent wrote the code, that's great — as long as you reviewed it and it works.

### Types of Contributions We Love

**New Ingestion Sources**
- RSS feed ingestion
- Scholarly article (arxiv, papers) ingestion
- Slack/Discord message export ingestion
- Browser history ingestion
- Email ingestion
- Podcast transcript ingestion
- Any content source that makes the KB smarter

**New MCP Tools**
- kb_watch — auto-ingest new files from a directory
- kb_deduplicate — find and merge duplicate content
- kb_export — export KB to various formats
- kb_stats_detailed — advanced analytics on knowledge base content

**Platform Integrations**
- OpenClaw skill packaging
- Cursor/Windsurf MCP configs
- Continue (VS Code) integration
- Docker Compose templates
- Kubernetes deployment
- Cloud deployment guides (AWS, GCP, Azure, Hetzner, DigitalOcean)

**Core Improvements**
- Performance optimization
- Better search ranking algorithms
- Multi-user support
- WebSocket real-time updates
- Watch mode for live vault ingestion

**Documentation**
- Tutorials and guides
- Video walkthroughs
- Translation to other languages
- Architecture diagrams
- Integration examples

### How to Submit

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-improvement`
3. Make your changes
4. Test locally: `npm install && npm link && kb start`
5. Commit with clear messages: `git commit -m "Add RSS feed ingestion source"`
6. Push: `git push origin feature/my-improvement`
7. Open a Pull Request with:
   - What you changed and why
   - How you tested it
   - Whether your AI agent helped (we're curious!)

### PR Requirements

- Code must work (test it locally)
- New features should include agent-readable docs (update EXTENDING.md or add inline comments)
- Follow existing code style (ES modules, async/await, Express patterns)
- No breaking changes to existing MCP tool interfaces (kb_search, kb_list, kb_read, kb_ingest must remain stable)
- New MCP tools should follow the naming pattern: kb_toolname

### Issue Labels

- `good-first-issue` — Great for newcomers or first-time AI-assisted contributions
- `agent-task` — Issues specifically designed to be solved by AI agents
- `ingestion` — New content source integrations
- `mcp-tool` — New MCP tool additions
- `integration` — Platform integrations
- `core` — Core engine improvements
- `docs` — Documentation improvements

### The agent-task Label

Issues labeled `agent-task` are specifically written for AI agents to solve. They include clear problem descriptions, expected behavior, relevant files, and test criteria.

Tell your agent: "Look at issue #X on this repo and implement it." The issue is written so your agent can understand and solve it.

## The Self-Learning Workflow (How We Build)

This project uses a self-learning development workflow. When you contribute, we encourage you to adopt it too:

1. **Before coding**: Search the KB for relevant context (`kb search "your topic"`)
2. **While coding**: Let your AI agent use MCP tools to read existing patterns
3. **After coding**: Capture what you learned (`kb_capture_session` or `kb_capture_fix`)
4. **On PR merge**: The new knowledge gets indexed and benefits every future contributor

See `docs/workflow/` for templates you can use in your own projects.

## Community Guidelines

- Be respectful and constructive
- Share what you learn — if your AI found a better approach, document it
- Credit your tools — it's cool to say "Claude helped me write this"
- Review before submitting — AI writes fast but human judgment catches edge cases
- Ask questions — open an issue if you're unsure about architecture decisions

## Development Setup

```bash
git clone https://github.com/uttambharadwaj/kb-graph.git
cd kb-graph
npm install
npm link
kb setup          # Interactive wizard configures everything
# OR manual:
KB_PASSWORD=dev kb start
```

The server runs on port 3838. Web dashboard at http://localhost:3838.
MCP server runs via: `kb mcp`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
