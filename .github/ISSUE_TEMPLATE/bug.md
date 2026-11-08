---
name: Bug report
about: Something does not work as documented
title: "bug: "
labels: bug
assignees: ""
---

<!--
Security problems: please do not open a public issue. Use GitHub's private
vulnerability reporting for this repository instead.

Never paste API keys, tokens, your real /etc/agent-workstation/workstation.toml or
Tailscale auth keys. Replace hostnames and addresses you consider private.
-->

## What happened

<!-- A clear description of the problem. -->

## What you expected

## Steps to reproduce

1.
2.
3.

## Environment

- Agent Workstation version or commit:
- Mode: development (TCP port) / tailnet (nginx + Tailscale)
- Client: web (browser and version) / macOS app (version, macOS version)
- Server: OS and version, architecture (for example Ubuntu 24.04 arm64), RAM
- Node version (`node -v`):
- Claude Code version (`sudo -u workstation-agent -H /opt/agent-workstation/claude/bin/claude --version`):

## Logs and screenshots

<!--
This issue is public. Before pasting logs or screenshots, remove: email addresses and usernames, Tailscale addresses
and names (100.x.y.z, *.ts.net), other IPs and host names, device names, absolute paths, session and project IDs,
chat or file contents, and every key, token or password. Paste only the lines around the problem, not a whole log.

Hub: `journalctl -u workstation-hub --since "10 min ago"`
Status service: `journalctl -u workstation-status --since "10 min ago"`
Browser console errors or a screenshot are often enough for UI problems.
-->

## Additional context
