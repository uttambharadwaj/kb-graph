# Obsidian Setup Guide

This guide covers setting up Obsidian as the human source of truth for the knowledge base system. Obsidian is where YOU curate knowledge. The KB server is the AI retrieval layer that makes it searchable for agents.

## Architecture

```
Phone/Desktop (Obsidian app + plugins)
  |
  |-- Obsidian Sync ($4/mo) -- bidirectional, real-time
  |
VPS/Server (Obsidian Headless)
  |
  |-- vault watcher --> KB server indexer --> SQLite FTS5
  |
AI Agents (Claude Code, Codex, Gemini, ChatGPT, Claude Web)
  |-- search/read via MCP or REST API
  |-- write back via kb_write, kb_capture_*
  |-- changes sync back to your phone via Obsidian Sync
```

## Part 1: Obsidian App Setup

### Install Obsidian

Download from [obsidian.md](https://obsidian.md) for your platform (Windows, macOS, Linux, iOS, Android).

### Create Your Vault

Create a new vault. This will be your knowledge base source of truth.

### Enable Obsidian Sync

Settings > Sync > Enable Obsidian Sync ($4/month). This syncs your vault between all devices including the headless server.

Alternatively, use git-based sync (free) — see "Alternative Sync" section below.

## Part 2: Recommended Plugins

Install these from Settings > Community Plugins > Browse.

### Required Plugins

These are essential for the knowledge base workflow:

**1. Omnisearch**
- Full-text search across your entire vault (faster than Obsidian's built-in search)
- Searches file contents, filenames, and frontmatter
- Provides instant results as you type
- Why: When you need to find something quickly on mobile before agents can help

**2. Templater**
- Advanced template engine with dynamic commands
- Create templates for each note type (research, fix, session, decision)
- Auto-insert dates, titles, and frontmatter on note creation
- Why: Ensures every note has proper frontmatter for KB classification

**3. Dataview**
- Query your vault like a database using inline queries
- Create dashboard views: "all notes tagged #fix this week"
- Filter by type, project, date, tags
- Why: Gives you a birds-eye view of your knowledge without leaving Obsidian

**4. Web Clipper** (browser extension, not a vault plugin)
- Available at [obsidian.md/clipper](https://obsidian.md/clipper)
- Clip web articles, tweets, documentation directly to your vault
- Configurable templates for different source types
- Content lands in your inbox folder, gets synced to server, auto-classified by KB
- Why: This is your primary capture mechanism for web content

### Automation Plugins (API Access)

These plugins expose your vault to external tools and scripts. They're what enable the KB server, agents, and automation workflows to interact with Obsidian programmatically.

**5. Local REST API**
- Exposes your Obsidian vault as a REST API on localhost
- Endpoints for reading, creating, updating, and searching notes
- Enables external scripts and services to interact with your vault
- Secured with an API key (configured in plugin settings)
- Why: This is how automation tools and agents can read/write to your vault when Obsidian is running on your desktop. Enables workflows like: agent finds something -> writes to vault via API -> you see it instantly

**6. Advanced URI**
- Deep linking to specific notes, headings, and blocks
- Create notes from URI parameters (title, content, frontmatter)
- Open specific views, run commands, and trigger actions via URI
- Works across platforms (desktop and mobile)
- Why: Enables automation shortcuts — bookmark a URI that creates a new research note with pre-filled template, or link directly to a specific section from external tools

### Recommended Plugins

These enhance the workflow significantly:

**7. Natural Language Dates**
- Type `@today` or `@next friday` in frontmatter and it converts to proper dates
- Works with Templater for auto-dating new notes
- Why: Consistent date formatting across all notes

**8. Tag Wrangler**
- Rename tags across the entire vault in one operation
- Merge duplicate tags (e.g., merge #bugfix and #bug-fix)
- Bulk tag operations from the tag pane
- Why: Keeps your tag taxonomy clean, which improves KB search quality

**9. Periodic Notes**
- Auto-create daily and weekly notes from templates
- Daily notes are great for quick captures throughout the day
- Weekly notes are perfect for synthesis and review
- Why: These get indexed by KB and agents can reference "what happened Monday"

**10. QuickAdd**
- Configurable quick-capture shortcuts
- One-tap note creation with pre-filled templates
- Multi-choice menus for different capture types
- Why: Reduces friction for capturing on mobile — tap, type, done

**11. Linter**
- Auto-format notes on save
- Enforce consistent frontmatter field ordering
- Clean up trailing whitespace and blank lines
- Why: Consistent formatting helps the KB parser and classifier

**12. Kanban**
- Turn any note into a Kanban board
- Visual project tracking inside your vault
- Boards sync like any other note
- Why: Track project status visually, syncs to all devices

### Optional Plugins

**13. Git** (desktop only)
- Version control your vault as a secondary backup
- See note change history
- Not needed if using Obsidian Sync, but adds safety

**14. Calendar**
- Visual calendar view linked to daily notes
- Quick navigation to any day's captures
- Why: Helpful for reviewing past work

## Part 3: Vault Structure

Create this folder structure in your vault:

```
00_inbox/              <-- Raw captures land here (Web Clipper, quick notes)
sources/
  youtube/             <-- YouTube transcripts
  x-bookmarks/         <-- X/Twitter bookmark exports
  captures/            <-- Web clippings, misc captures
research/              <-- Refined research summaries
ideas/                 <-- Business and product ideas
workflows/             <-- Process documentation and rules
decisions/             <-- Architecture and strategy decisions
builds/
  sessions/            <-- Coding session summaries (from kb_capture_session)
  fixes/               <-- Bug fix documentation (from kb_capture_fix)
```

The KB server's `kb_classify` tool auto-routes content to the right folder. You can also organize manually.

## Part 4: Frontmatter Standard

Every note should have YAML frontmatter for proper classification:

```yaml
---
type: research
tags: docker, networking, infrastructure
project: my-project
created: 2026-03-17
status: active
confidence: high
source: https://example.com/article
---

Note content goes here...
```

### Frontmatter Fields

| Field | Required | Values | Purpose |
|-------|----------|--------|---------|
| type | Yes | research, idea, workflow, lesson, fix, decision, session, capture | Determines vault folder and retrieval ranking |
| tags | Yes | Comma-separated | Search and filtering |
| project | No | Project name | Routes to project context |
| created | Yes | YYYY-MM-DD | Chronological ordering |
| status | No | active, archived | Filter active vs old content |
| confidence | No | high, medium, low | Retrieval ranking weight |
| source | No | URL or description | Attribution and reference |

### Templater Templates

Create these in a `_templates/` folder:

**Research Note Template:**
```markdown
---
type: research
tags:
project:
created: <% tp.date.now("YYYY-MM-DD") %>
status: active
source:
---

## Summary

## Key Points

## Implications
```

**Fix Note Template:**
```markdown
---
type: fix
tags: fix
project:
created: <% tp.date.now("YYYY-MM-DD") %>
status: active
---

## Symptom

## Root Cause

## Resolution

## Lesson
```

## Part 5: Headless Server Setup

This runs on your VPS/server to keep the vault synced for the KB server.

### Install obsidian-headless

```bash
npm install -g obsidian-headless
```

### Login to Obsidian

```bash
ob login
```

Enter your Obsidian account credentials.

### Initial Sync

```bash
mkdir -p ~/obsidian-vault
ob sync --path ~/obsidian-vault
```

Wait for all files to download.

### Create systemd Service

```bash
sudo tee /etc/systemd/system/obsidian-sync.service << EOF
[Unit]
Description=Obsidian Headless Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$HOME/obsidian-vault
Environment=NODE_ENV=production
Environment=HOME=$HOME
Environment=PATH=$(dirname $(which node)):/usr/local/bin:/usr/bin:/bin
ExecStart=$(which node) $(which ob) sync --continuous --path $HOME/obsidian-vault
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable obsidian-sync
sudo systemctl start obsidian-sync
```

### Verify

```bash
systemctl status obsidian-sync
# Should show "Fully synced" in logs
```

The service polls every ~30 seconds. Changes on your phone appear on the server within a minute.

### Connect to KB Server

Set the vault path in your KB server `.env`:

```bash
OBSIDIAN_VAULT_PATH=/home/youruser/obsidian-vault
```

Restart the KB server. It will auto-index the vault on startup.

## Part 6: Alternative Sync (Free, No Obsidian Sync)

If you don't want to pay for Obsidian Sync, use git:

```bash
# On your server
cd ~/obsidian-vault
git init
git remote add origin your-private-repo-url

# Set up cron to pull every 5 minutes
crontab -e
# Add: */5 * * * * cd ~/obsidian-vault && git pull --quiet
```

On desktop, use the Obsidian Git plugin to auto-commit and push.

Limitation: Not real-time like Obsidian Sync. 5-minute delay.

## Part 7: The Full Sync Flow

```
1. You clip an article on your phone (Web Clipper)
2. Note lands in 00_inbox/ in your Obsidian vault
3. Obsidian Sync pushes to server (~30 seconds)
4. obsidian-headless receives the file
5. KB server vault watcher detects new file (content hash)
6. File gets indexed into SQLite FTS5
7. kb_classify auto-tags it (type, project, summary)
8. Note moves from inbox to proper folder
9. Agent searches KB, finds the article with context
10. Agent uses the knowledge in its response
11. Agent captures session findings back to vault (kb_capture_*)
12. Obsidian Sync pushes capture to your phone
13. You see the agent's work in your Obsidian app
```

Full circle. Human curates. AI retrieves. AI writes back. Human reviews.

## Costs

| Service | Cost |
|---------|------|
| Obsidian app | Free |
| Obsidian Sync | $4/month (or free with git sync) |
| Community plugins | Free |
| obsidian-headless | Free (npm package) |
| VPS (shared) | ~$5-10/month |

Total: $4-14/month for an always-on AI brain synced to all your devices.
