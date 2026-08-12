#!/bin/zsh
node "/Users/coreybaines/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" task --write --model gpt-5.6-sol --effort high "$(cat /tmp/codex-brief-triggers.md)"
