# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

- Preferred: use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (the **Security → Report a vulnerability** button on this repository).
- Alternatively, email **jmheath@gmail.com** with details and reproduction steps.

You'll get an acknowledgement as soon as it's seen. Please allow reasonable time
to investigate and ship a fix before any public disclosure.

## Scope & nature of this project

This is a personal [Claude Code](https://docs.claude.com/en/docs/claude-code)
plugin: Markdown skill definitions plus a few zero-dependency Node scripts (using
only `node:` built-ins). There is no runtime service and no bundled
dependencies. The most relevant concerns are therefore:

- **Accidental secret exposure** in committed files or history. Secret scanning
  (gitleaks) runs in CI on every push and pull request.
- **Untrusted input to the helper scripts** under `scripts/` and
  `skills/*/scripts/` (they shell out to the `claude` CLI and read local files).

If you find either, the reporting channels above are the right place.
