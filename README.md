# Paseo Transfer

Copy or move a Git workspace between two Paseo hosts.

The plugin creates a new folder on the destination host. This folder contains a Git repository and a worktree. The plugin then registers this worktree as a Paseo workspace.

## Installation

Requirements on both hosts:

- Paseo **0.13.x**;
- Node.js **22 or later**;
- Git;
- the plugin enabled in **Settings → Plugins**.

Run on each host:

```sh
paseo plugin add git:yboyer/paseo-transfert
```

The plugin uses connections registered **on the source daemon**. A connection visible only in your app is not enough. Connect the destination host to the source daemon through the Paseo settings or the `paseo host add` command. The plugin does not require additional SSH configuration.

Transport dependencies are installed with `npm ci --omit=dev --ignore-scripts`. Paseo needs access to the npm registry during installation.

## Usage

1. Open the source workspace and click **Transfer** in its header. You can also use the sidebar or the Command Center.
2. Select the destination host.
3. Enter a parent directory that **already exists on that host** and a new folder name.
4. Choose **Copy** or **Move**.
5. Review the preview and confirm the copy.
6. To move the workspace, wait for verification, then confirm source archiving.

Example destination:

```text
/Users/you/Code/my-local-project/
├── repository.git/    # Git repository with history
└── worktree/          # Paseo workspace code
```

The destination folder must not exist. Existing folders are never overwritten. Returning to the original host also requires a new folder. Copies remain independent.

## Transferred content

- Git history reachable from local references, branches, tags, and HEAD.
- Tracked files in their current state, including deletions.
- Staged changes, preserved separately from unstaged changes.
- Untracked files that are not ignored by Git.
- Binary files, executable permissions, and symbolic links within the project.

Git-ignored files are not copied. This exclusion applies to current files, **not to versions already in Git history**. The preview lists included paths and ignored files or folders.

Conversations, provider credentials, MCP settings, and local Git configuration are not transferred. The received repository has no configured remote. Configuration files tracked by Git remain project files and are copied like other files.

## Copy and move

**Copy** preserves the source.

**Move** first performs the same copy. The user then confirms archiving in Paseo. The plugin checks the source and destination again before requesting archiving.

- If Paseo manages the source worktree, archiving may delete that worktree.
- For a local checkout or a worktree created by Transfer, archiving removes the workspace from Paseo and keeps its files on disk. The plugin does not directly delete these folders.
- Ignored files or folders block moving to prevent data loss.
- Stop agents and close source terminals before archiving.

Also stop editors, scripts, and other programs that write to the project during the operation. The plugin cannot lock external programs.

## Checks and limits

The transfer verifies a SHA-256 checksum, restored file contents, and staged changes. It rejects unsafe paths, external symbolic links, case collisions, and occupied destinations.

First version limits:

- Linux, macOS, and WSL; native Windows is not supported.
- The workspace must point to the root of a Git checkout with at least one commit.
- No submodules, Git LFS, or unresolved Git conflicts.
- A maximum of 20,000 files and a transfer archive of up to 128 MiB. The archive includes history and base64-encoded data.
- No automatic synchronization, merging into an existing destination, or conversation resuming.
- The new worktree uses a `transfert/<id>` branch. Original references remain in the received repository.
- The transfer does not run Git hooks or project setup scripts.

A preview expires after 15 minutes. Source changes require a new preview. The transfer continues if you leave the screen, as long as both daemons and the plugin remain running.

The tracking ID lets you retrieve an operation on the same source host for about an hour. Tracking and source archiving confirmation do not survive a plugin restart. Completed copies remain on disk.

If a transfer fails, the source stays intact. A partial folder may remain at the destination. Review its contents before removing it. Use a new folder for another attempt. The transfer does not automatically resume previously received chunks.

## Development

```sh
npm ci
npm run check
```

Run a full test with two temporary daemons, without using your regular hosts:

```sh
npm install --global @getpaseo/cli@0.13.0
npm run test:e2e
```

This test installs the plugin, connects the daemons, copies a real worktree, checks the received workspace, tests archive refusals, and then archives a source worktree managed by Paseo.

The Paseo Node transport is isolated in `server/connection.ts`. It uses the local daemon identity and its authenticated routes. The SDK does not expose a public method for cross-host plugin RPCs. The plugin therefore uses its low-level client, pinned to version 0.13.0. Paseo support is limited to 0.13.x until later versions are verified.

Automated tests cover the server and transfers between daemons. The UI still needs verification in the Paseo desktop and mobile clients.
