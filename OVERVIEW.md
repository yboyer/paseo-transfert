# Transfer

Copy or move Git workspaces between two Paseo hosts.

- Choose a host and an existing Git project from its project cards.
- Create a new branch at the exact source commit, with a new worktree and workspace.
- Review files and exclusions before copying.
- Preserve staged and unstaged changes without modifying existing destination workspaces.
- Confirm source archiving after a verified copy.

Install or update the plugin on both hosts and connect them in the Paseo app. Keep the app open until the transfer finishes. No daemon-to-daemon pairing is needed. Paseo 0.13.x, Node.js 22, and Git are required. Conversations and Git-ignored files are excluded. Copies remain independent.
