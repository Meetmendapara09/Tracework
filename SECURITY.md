# Security policy

Tracework is a local-first, single-user tool with **no authentication**. It is designed to run on your own machine or private infrastructure, never on the public internet.

## Supported versions

Security fixes are provided for the latest `main` commit. There are no maintained release branches.

## Reporting a vulnerability

Open a private security advisory on GitHub or contact the maintainer through a GitHub issue asking for a private channel. Please include:

- A description of the issue and its impact
- Steps to reproduce
- The commit you tested against

Do not open a public issue for vulnerabilities that allow data access or code execution.

## Scope notes

- The server intentionally has no login, so anyone who can reach it can read and modify workspaces. Only bind it to loopback or a trusted network behind your own authentication and TLS proxy.
- Workspace JSON files and attached PDFs may contain sensitive research. Protect them with OS permissions and backups.
- Tracework never fetches source URLs. Pasting untrusted content is safe for storage, and all rendered content is escaped.
