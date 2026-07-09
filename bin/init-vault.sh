#!/bin/bash
VAULT="${OBSIDIAN_VAULT_PATH:-$HOME/obsidian-vault}"

dirs=(
  "inbox"
  "sources/web"
  "sources/youtube"
  "sources/x-bookmarks"
  "sources/email"
  "projects"
  "People"
  "companies"
  "research"
  "research/weekly"
  "ideas"
  "workflows"
  "agents/claude"
  "agents/codex"
  "agents/gemini"
  "agents/lessons"
  "decisions"
  "system/runbooks"
  "builds/sessions"
  "builds/fixes"
  "archive"
  "templates"
  "assets"
)

for dir in "${dirs[@]}"; do
  mkdir -p "$VAULT/$dir"
  echo "Created: $dir"
done

echo "Vault structure initialized at $VAULT"
