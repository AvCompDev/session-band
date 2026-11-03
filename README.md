# session-band

A band above the Claude prompt box showing this session's cost (total, last turn, average, and a small trend line), tokens (total, output, turns) and agent time (total and average per turn). Each session's totals are saved on the machine it runs on, so reopening a session picks up where it left off (the last 200 sessions are kept). A fourth line shows the all-time total across every session on that machine: cost, tokens, turns, sessions and agent time.

Buttons:

- **Copy** - copies Claude's last reply to the clipboard.
- **Review** - asks Claude to review this session's code changes with the secure-coding skill (no file changes until you confirm).
- **Audit** - asks Claude to security-audit changed code, skills and plugins (findings only).
- **Board** - opens a task board pane that follows the tasks Claude creates. Also `/session-board`.
- **Compact** - compacts the conversation to save tokens.

## Install

At the prompt of a terminal session:

```
/plugin install session-band --marketplace AvCompDev/session-band
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install session-band --marketplace AvCompDev/session-band
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `AvCompDev/session-band`, then Add plugin.

This is a private repository: it installs only on machines with a GitHub credential that can read it (`gh auth login`, then `gh auth setup-git`).
