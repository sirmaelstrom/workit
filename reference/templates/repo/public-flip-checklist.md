# Public-flip checklist

A private repository on GitHub's free plan cannot turn on branch protection or rulesets. The API answers 403 with "Upgrade to GitHub Pro or make this repository public". Native secret scanning and push protection are also unavailable on it. `conduct bootstrap` prepares everything a private repo *can* have. This list is what waits for the repository to go public, or for a paid plan. Run it top to bottom on the day of the flip, as someone with admin rights on the repo.

Set these first:

```bash
REPO=<owner>/<name>
DEFAULT=main
# The exact job names your CI reports, as listed under "checks" on a PR.
CHECK_1="Check"
CHECK_2="Secret scan (gitleaks)"
```

## 1. Before the flip: what becomes world-readable

- [ ] Scan the full history, not only the tip: `gitleaks git --no-banner --redact`. Treat a hit in an old commit the same as a hit at HEAD: rotate the secret first, then decide whether to rewrite history.
- [ ] Search history for host topology and personal data (internal hostnames, LAN IPs, absolute home-directory paths, employer names). Grep `git log -p` for them and decide on each hit.
- [ ] Open issues and PR bodies become public too. Read through them.
- [ ] `conduct bootstrap --repo <path>` passes (exit 0), so README, LICENSE, SECURITY.md, the PR template and CI are already in place.

## 2. The flip

- [ ] `gh repo edit $REPO --visibility public --accept-visibility-change-consequences`
- [ ] `gh repo view $REPO --json visibility` prints `PUBLIC`.

## 3. Branch protection on the default branch

Changes go through a PR, both checks must pass, force-pushes and deletion are blocked, and the admin bypass stays on for a solo maintainer:

```bash
gh api -X PUT repos/$REPO/branches/$DEFAULT/protection --input - <<JSON
{
  "required_status_checks": { "strict": true, "checks": [ { "context": "$CHECK_1" }, { "context": "$CHECK_2" } ] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

- [ ] Verify: `gh api repos/$REPO/branches/$DEFAULT/protection --jq '{strict: .required_status_checks.strict, checks: [.required_status_checks.checks[].context], force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'`

## 4. Security features that are free on a public repo

- [ ] Secret scanning and push protection: `gh api -X PATCH repos/$REPO -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'`
- [ ] Dependabot alerts: `gh api -X PUT repos/$REPO/vulnerability-alerts`
- [ ] Dependabot security updates: `gh api -X PUT repos/$REPO/automated-security-fixes`
- [ ] Private vulnerability reporting (the channel SECURITY.md points at): `gh api -X PUT repos/$REPO/private-vulnerability-reporting`
- [ ] Verify: `gh api repos/$REPO --jq '.security_and_analysis'`

## 5. After the flip

- [ ] Open a trivial PR and confirm both required checks block the merge until they pass.
- [ ] `deleteBranchOnMerge` is still `true`: `gh repo view $REPO --json deleteBranchOnMerge`.
- [ ] Record the flip (date, commands run, verification output) wherever the project keeps its decisions.
