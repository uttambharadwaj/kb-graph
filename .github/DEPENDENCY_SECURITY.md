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

## Production audit state (2026-09-21)

`npm audit --omit=dev` reports no advisories. PF-3890 upgraded the direct production
dependency `@huggingface/transformers` from 3.8.1 to 4.3.0, which updates transitive
`sharp` from 0.34.5 to 0.35.4 and resolves both previously accepted high advisories:

- `GHSA-f88m-g3jw-g9cj` (`sharp <0.35.0`)
- `GHSA-rgj7-g3m4-5g8c` (`sharp <0.35.4`)

The baseline is intentionally empty. Do not retain an exception after its exact
package/GHSA pair disappears from the live audit.

The three moderate Express-chain advisories named in PF-4111 are no longer present:
the lockfile now resolves `express@4.22.2`, `body-parser@1.20.8`, and `qs@6.16.0`.
PF-3888 remains the separate Express 5 migration and is not folded into this policy.
