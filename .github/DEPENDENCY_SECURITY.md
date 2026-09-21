# Dependency advisory policy

Pull requests that change `package.json` or `package-lock.json` must not introduce a
high- or critical-severity advisory. The dependency-review job compares the pull
request's dependency graph with `main`; the audit-baseline job independently checks
the npm audit report against `.github/dependency-advisory-baseline.json`.

The audit job also runs on a schedule and can be dispatched manually. Keeping its live
registry call out of unrelated pull requests prevents npm registry outages or newly
published advisories against an unchanged lockfile from blocking unrelated work.
Malformed reports and exhausted registry retries still fail loud on dependency changes
and scheduled monitoring.

Baseline entries are exact package/GHSA pairs. Each one records directness, fix
availability, reachability, owner, tracking issues, and an expiry. Missing advisories,
changed identities or classifications, expired entries, and unreviewed high/critical
advisories all fail. Wildcards are invalid. Update an entry only after reviewing the
current advisory and lockfile; delete it when the advisory no longer applies.

## Reviewed production debt (2026-09-21)

`npm audit --omit=dev` reports two high advisories and no critical, moderate, low, or
informational advisories. Both are on `sharp@0.34.5`, installed transitively by the
direct production dependency `@huggingface/transformers@3.8.1`:

- `GHSA-f88m-g3jw-g9cj` (`sharp <0.35.0`)
- `GHSA-rgj7-g3m4-5g8c` (`sharp <0.35.4`)

kb-graph imports Transformers.js at runtime for the text-only
`Xenova/all-MiniLM-L6-v2` feature-extraction pipeline. It does not import `sharp` or
invoke an image decoder directly, so the vulnerable codec paths are not reached by the
intended workload. The affected native package is nevertheless installed in production.
npm's offered remediation upgrades Transformers.js to 4.3.0, a semver-major change;
PF-3890 owns that decision and PF-3887 tracks the security batch.

The three moderate Express-chain advisories named in PF-4111 are no longer present:
the lockfile now resolves `express@4.22.2`, `body-parser@1.20.8`, and `qs@6.16.0`.
PF-3888 remains the separate Express 5 migration and is not folded into this policy.
