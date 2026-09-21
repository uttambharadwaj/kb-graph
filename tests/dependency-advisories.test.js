import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AuditSourceError,
  PolicyDataError,
  evaluateAudit,
  extractQualifyingAdvisories,
  obtainAuditReport,
  parseAuditExecution,
  validateBaseline,
} from '../scripts/check-dependency-advisories.mjs';

const fixtures = JSON.parse(readFileSync(
  new URL('./fixtures/dependency-audits.json', import.meta.url),
  'utf8',
));
const reviewedBaseline = JSON.parse(readFileSync(
  new URL('../.github/dependency-advisory-baseline.json', import.meta.url),
  'utf8',
));
const workflow = readFileSync(
  new URL('../.github/workflows/dependency-security.yml', import.meta.url),
  'utf8',
);
const AS_OF = { asOf: '2026-09-21' };

function emptyBaseline() {
  return { schemaVersion: 1, advisories: [] };
}

function clone(value) {
  return structuredClone(value);
}

function acceptedEntry(advisory) {
  return {
    ...advisory,
    reason: 'Reviewed transitive fixture.',
    affectedSurface: 'Fixture dependency path.',
    owner: 'Product Foundation',
    trackingIssues: [`PF-${String(9999)}`],
    reviewedAt: '2026-09-21',
    expiresOn: '2026-12-21',
  };
}

describe('dependency advisory policy', () => {
  it('accepts a clean audit against an empty baseline', () => {
    const result = evaluateAudit(fixtures.clean, emptyBaseline(), AS_OF);
    assert.equal(result.ok, true);
    assert.deepEqual(result.observed, []);
  });

  it('rejects newly introduced high and critical advisory identities', () => {
    const result = evaluateAudit(fixtures.newQualifying, emptyBaseline(), AS_OF);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /new high advisory direct-risk:GHSA-2345-6789-cfgh/);
    assert.match(result.errors.join('\n'), /new critical advisory transitive-risk:GHSA-jmpq-rvwx-2345/);
  });

  it('ignores low and moderate advisories', () => {
    const report = clone(fixtures.newQualifying);
    report.vulnerabilities['direct-risk'].severity = 'low';
    report.vulnerabilities['direct-risk'].via[0].severity = 'low';
    report.vulnerabilities['transitive-risk'].severity = 'moderate';
    report.vulnerabilities['transitive-risk'].via[0].severity = 'moderate';
    assert.equal(evaluateAudit(report, emptyBaseline(), AS_OF).ok, true);
  });

  it('fails loud when a removed advisory leaves a stale exception', () => {
    const result = evaluateAudit(fixtures.clean, reviewedBaseline, AS_OF);
    assert.equal(result.ok, false);
    assert.equal(result.errors.filter(error => error.startsWith('stale baseline exception')).length, 2);
  });

  it('treats a changed GHSA identity as both new and stale', () => {
    const report = clone(fixtures.current);
    report.vulnerabilities.sharp.via[1].url =
      'https://github.com/advisories/GHSA-w234-x567-cf89';

    const result = evaluateAudit(report, reviewedBaseline, AS_OF);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /new high advisory sharp:GHSA-w234-x567-cf89/);
    assert.match(result.errors.join('\n'), /stale baseline exception sharp:GHSA-rgj7-g3m4-5g8c/);
  });

  it('rejects changed severity, directness, and fix classification', () => {
    for (const [field, value] of [
      ['severity', 'critical'],
      ['direct', true],
      ['fixAvailable', false],
    ]) {
      const report = clone(fixtures.current);
      if (field === 'severity') report.vulnerabilities.sharp.via[0].severity = value;
      else if (field === 'direct') report.vulnerabilities.sharp.isDirect = value;
      else report.vulnerabilities.sharp[field] = value;
      const result = evaluateAudit(report, reviewedBaseline, AS_OF);
      assert.equal(result.ok, false, `${field} drift must fail`);
      assert.match(result.errors.join('\n'), new RegExp(`changed ${field === 'fixAvailable' ? 'fixAvailability' : field}`));
    }
  });

  it('rejects malformed audit graphs', () => {
    assert.throws(
      () => evaluateAudit(fixtures.malformed, emptyBaseline(), AS_OF),
      error => error instanceof PolicyDataError && /references missing package/.test(error.message),
    );
  });

  it('rejects malformed observed advisory identities', () => {
    const report = clone(fixtures.fixableDirect);
    report.vulnerabilities['direct-risk'].via[0].url = 'https://github.com/advisories/GHSA-3456';
    assert.throws(
      () => extractQualifyingAdvisories(report),
      error => error instanceof PolicyDataError && /lacks exact package\/GHSA identity/.test(error.message),
    );
  });

  it('retries and fails closed without echoing network or registry details', () => {
    for (const fixture of [fixtures.networkFailure, fixtures.registryFailure]) {
      let attempts = 0;
      assert.throws(
        () => obtainAuditReport({
          attempts: 3,
          execute: () => {
            attempts += 1;
            return { status: 1, stdout: JSON.stringify(fixture) };
          },
        }),
        error => error instanceof AuditSourceError
          && /npm audit unavailable after 3 attempts/.test(error.message)
          && !error.message.includes(fixture.error.summary),
      );
      assert.equal(attempts, 3);
    }
  });

  it('rejects malformed output and recovers when a later audit attempt succeeds', () => {
    assert.throws(
      () => parseAuditExecution({ status: 1, stdout: 'not-json' }),
      error => error instanceof AuditSourceError && /malformed JSON/.test(error.message),
    );
    assert.throws(
      () => parseAuditExecution({ status: 2, stdout: JSON.stringify(fixtures.clean) }),
      error => error instanceof AuditSourceError && /exited unexpectedly/.test(error.message),
    );

    let attempts = 0;
    const report = obtainAuditReport({
      attempts: 2,
      execute: () => {
        attempts += 1;
        if (attempts === 1) {
          return { status: 1, stdout: JSON.stringify(fixtures.networkFailure) };
        }
        return { status: 0, stdout: JSON.stringify(fixtures.clean) };
      },
    });
    assert.deepEqual(report, fixtures.clean);
    assert.equal(attempts, 2);

    attempts = 0;
    const recoveredFromMalformedGraph = obtainAuditReport({
      attempts: 2,
      execute: () => {
        attempts += 1;
        return {
          status: attempts === 1 ? 1 : 0,
          stdout: JSON.stringify(attempts === 1 ? fixtures.malformed : fixtures.clean),
        };
      },
    });
    assert.deepEqual(recoveredFromMalformedGraph, fixtures.clean);
    assert.equal(attempts, 2);
  });

  it('rejects a new fixable direct dependency advisory', () => {
    const result = evaluateAudit(fixtures.fixableDirect, emptyBaseline(), AS_OF);
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join('\n'),
      /direct-risk:GHSA-3456-789c-fghj \(direct, nonbreaking fix\)/,
    );
  });

  it('accepts an exact reviewed transitive no-fix advisory', () => {
    const observed = extractQualifyingAdvisories(fixtures.transitiveNoFix);
    assert.deepEqual(observed, [{
      package: 'transitive-risk',
      advisoryId: 'GHSA-4567-89cf-ghjm',
      severity: 'high',
      direct: false,
      fixAvailability: 'none',
    }]);

    const result = evaluateAudit(
      fixtures.transitiveNoFix,
      { schemaVersion: 1, advisories: observed.map(acceptedEntry) },
      AS_OF,
    );
    assert.equal(result.ok, true);
  });

  it('accepts the exact reviewed current advisory set and rejects expiry', () => {
    assert.equal(evaluateAudit(fixtures.current, reviewedBaseline, AS_OF).ok, true);
    assert.throws(
      () => evaluateAudit(fixtures.current, reviewedBaseline, { asOf: '2026-12-22' }),
      error => error instanceof PolicyDataError && /expired on 2026-12-21/.test(error.message),
    );
  });

  it('rejects broad, duplicate, incomplete, impossible, and future-dated exceptions', () => {
    const valid = reviewedBaseline.advisories[0];
    const invalidBaselines = [
      { ...valid, package: '*' },
      { ...valid, advisoryId: 'GHSA-3456' },
      { ...valid, reason: '' },
      { ...valid, reviewedAt: '2026-02-31' },
      { ...valid, reviewedAt: '2026-09-22' },
    ].map(advisory => ({ schemaVersion: 1, advisories: [advisory] }));
    invalidBaselines.push({ schemaVersion: 1, advisories: [valid, valid] });

    for (const baseline of invalidBaselines) {
      assert.throws(() => validateBaseline(baseline, AS_OF), PolicyDataError);
    }
    assert.doesNotThrow(() => validateBaseline(reviewedBaseline, { asOf: '2026-12-21' }));
  });

  it('keeps the workflow pinned, fork-safe, and scoped away from unrelated pull requests', () => {
    const uses = [...workflow.matchAll(/uses:\s+([^@\s]+)@([0-9a-f]{40})/g)]
      .map(([, action, sha]) => ({ action, sha }));
    assert.deepEqual(uses, [
      { action: 'actions/checkout', sha: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
      { action: 'actions/dependency-review-action', sha: 'a1d282b36b6f3519aa1f3fc636f609c47dddb294' },
      { action: 'actions/checkout', sha: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
      { action: 'actions/setup-node', sha: '820762786026740c76f36085b0efc47a31fe5020' },
    ]);
    assert.match(workflow, /pull_request:\n\s+branches: \[main\]\n\s+paths:/);
    assert.match(workflow, /- package-lock\.json/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(workflow, /pull_request_target|secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|\.npmrc/);
  });
});
