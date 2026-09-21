#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASELINE_URL = new URL('../.github/dependency-advisory-baseline.json', import.meta.url);
const QUALIFYING_SEVERITIES = new Set(['high', 'critical']);
const VALID_FIX_AVAILABILITY = new Set(['none', 'nonbreaking', 'semver-major']);
const GHSA_ID_PATTERN = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;
const REQUIRED_BASELINE_FIELDS = [
  'package',
  'advisoryId',
  'severity',
  'direct',
  'fixAvailability',
  'reason',
  'affectedSurface',
  'owner',
  'trackingIssues',
  'reviewedAt',
  'expiresOn',
];

export class AuditSourceError extends Error {}
export class PolicyDataError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function advisoryKey({ package: packageName, advisoryId }) {
  return `${packageName}:${advisoryId}`;
}

function assertDate(value, field, key) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().slice(0, 10) !== value) {
    throw new PolicyDataError(`${key}.${field} must be an ISO date`);
  }
}

function validateBaselineEntry(entry, asOf) {
  if (!isObject(entry)) throw new PolicyDataError('baseline advisories must be objects');
  const missing = REQUIRED_BASELINE_FIELDS.filter(field => !(field in entry));
  if (missing.length) throw new PolicyDataError(`baseline entry is missing: ${missing.join(', ')}`);

  const key = advisoryKey(entry);
  if (!entry.package || entry.package.includes('*')) {
    throw new PolicyDataError(`${key}.package must be an exact package name`);
  }
  if (!GHSA_ID_PATTERN.test(entry.advisoryId)) {
    throw new PolicyDataError(`${key}.advisoryId must be an exact GHSA identifier`);
  }
  if (!QUALIFYING_SEVERITIES.has(entry.severity)) {
    throw new PolicyDataError(`${key}.severity must be high or critical`);
  }
  if (typeof entry.direct !== 'boolean') {
    throw new PolicyDataError(`${key}.direct must be boolean`);
  }
  if (!VALID_FIX_AVAILABILITY.has(entry.fixAvailability)) {
    throw new PolicyDataError(`${key}.fixAvailability is invalid`);
  }
  for (const field of ['reason', 'affectedSurface', 'owner']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      throw new PolicyDataError(`${key}.${field} must be non-empty`);
    }
  }
  if (!Array.isArray(entry.trackingIssues) || entry.trackingIssues.length === 0
      || entry.trackingIssues.some(issue => !/^PF-\d+$/.test(issue))) {
    throw new PolicyDataError(`${key}.trackingIssues must contain exact PF issue identifiers`);
  }
  assertDate(entry.reviewedAt, 'reviewedAt', key);
  assertDate(entry.expiresOn, 'expiresOn', key);
  if (entry.reviewedAt > asOf) {
    throw new PolicyDataError(`${key}.reviewedAt is in the future`);
  }
  if (entry.expiresOn < entry.reviewedAt) {
    throw new PolicyDataError(`${key}.expiresOn precedes reviewedAt`);
  }
  if (entry.expiresOn < asOf) {
    throw new PolicyDataError(`${key} expired on ${entry.expiresOn}`);
  }
}

export function validateBaseline(baseline, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  if (!isObject(baseline) || baseline.schemaVersion !== 1 || !Array.isArray(baseline.advisories)) {
    throw new PolicyDataError('baseline must use schemaVersion 1 and contain an advisories array');
  }
  const seen = new Set();
  for (const entry of baseline.advisories) {
    validateBaselineEntry(entry, asOf);
    const key = advisoryKey(entry);
    if (seen.has(key)) throw new PolicyDataError(`duplicate baseline entry: ${key}`);
    seen.add(key);
  }
}

function normalizeFixAvailability(fixAvailable) {
  if (!fixAvailable) return 'none';
  if (fixAvailable === true) return 'nonbreaking';
  if (!isObject(fixAvailable) || typeof fixAvailable.isSemVerMajor !== 'boolean') {
    throw new PolicyDataError('audit fixAvailable must be false, true, or a versioned fix object');
  }
  return fixAvailable.isSemVerMajor ? 'semver-major' : 'nonbreaking';
}

function ghsaFromUrl(url) {
  if (typeof url !== 'string') return null;
  const advisoryId = url.match(/\/advisories\/([^/?#]+)$/)?.[1];
  return advisoryId && GHSA_ID_PATTERN.test(advisoryId) ? advisoryId : null;
}

function resolvePackageAdvisories(report, packageName, resolving, resolved) {
  if (resolved.has(packageName)) return resolved.get(packageName);
  if (resolving.has(packageName)) {
    throw new PolicyDataError(`audit report contains a vulnerability cycle at ${packageName}`);
  }

  const vulnerability = report.vulnerabilities[packageName];
  if (!isObject(vulnerability) || !Array.isArray(vulnerability.via)
      || typeof vulnerability.isDirect !== 'boolean') {
    throw new PolicyDataError(`audit vulnerability ${packageName} is malformed`);
  }

  resolving.add(packageName);
  const advisories = [];

  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      if (!(via in report.vulnerabilities)) {
        throw new PolicyDataError(`audit vulnerability ${packageName} references missing package ${via}`);
      }
      advisories.push(...resolvePackageAdvisories(report, via, resolving, resolved));
      continue;
    }
    if (!isObject(via) || typeof via.severity !== 'string') {
      throw new PolicyDataError(`audit vulnerability ${packageName} has malformed advisory data`);
    }
    if (!QUALIFYING_SEVERITIES.has(via.severity)) continue;

    const advisoryId = ghsaFromUrl(via.url);
    const advisoryPackage = via.dependency || via.name || packageName;
    if (!advisoryId || typeof advisoryPackage !== 'string') {
      throw new PolicyDataError(`audit vulnerability ${packageName} lacks exact package/GHSA identity`);
    }

    const advisoryNode = report.vulnerabilities[advisoryPackage] ?? vulnerability;
    advisories.push({
      package: advisoryPackage,
      advisoryId,
      severity: via.severity,
      direct: advisoryNode.isDirect,
      fixAvailability: normalizeFixAvailability(advisoryNode.fixAvailable),
    });
  }

  resolving.delete(packageName);
  if (QUALIFYING_SEVERITIES.has(vulnerability.severity) && advisories.length === 0) {
    throw new PolicyDataError(`qualifying vulnerability ${packageName} has no qualifying advisory identity`);
  }

  resolved.set(packageName, advisories);
  return advisories;
}

export function extractQualifyingAdvisories(report) {
  if (!isObject(report) || !isObject(report.vulnerabilities)) {
    throw new PolicyDataError('audit report must contain a vulnerabilities object');
  }

  const resolving = new Set();
  const resolved = new Map();

  const advisories = new Map();
  for (const packageName of Object.keys(report.vulnerabilities)) {
    const packageAdvisories = resolvePackageAdvisories(report, packageName, resolving, resolved);
    for (const advisory of packageAdvisories) {
      const key = advisoryKey(advisory);
      const previous = advisories.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(advisory)) {
        throw new PolicyDataError(`audit report disagrees about ${key}`);
      }
      advisories.set(key, advisory);
    }
  }
  return [...advisories.values()].sort((a, b) => advisoryKey(a).localeCompare(advisoryKey(b)));
}

export function evaluateAudit(report, baseline, options) {
  validateBaseline(baseline, options);
  const observed = extractQualifyingAdvisories(report);
  const observedByKey = new Map(observed.map(item => [advisoryKey(item), item]));
  const baselineByKey = new Map(baseline.advisories.map(item => [advisoryKey(item), item]));
  const errors = [];

  for (const advisory of observed) {
    const key = advisoryKey(advisory);
    const accepted = baselineByKey.get(key);
    if (!accepted) {
      errors.push(`new ${advisory.severity} advisory ${key} (${advisory.direct ? 'direct' : 'transitive'}, ${advisory.fixAvailability} fix)`);
      continue;
    }
    for (const field of ['severity', 'direct', 'fixAvailability']) {
      if (accepted[field] !== advisory[field]) {
        errors.push(`${key} changed ${field}: baseline=${accepted[field]} current=${advisory[field]}`);
      }
    }
  }

  for (const key of baselineByKey.keys()) {
    if (!observedByKey.has(key)) errors.push(`stale baseline exception ${key} no longer matches the audit`);
  }

  return { ok: errors.length === 0, observed, errors };
}

function safeAuditErrorCode(report) {
  const code = report?.error?.code;
  return typeof code === 'string' && /^[A-Z0-9_-]{1,40}$/.test(code) ? code : 'unknown';
}

export function parseAuditExecution({ status, stdout, error }) {
  if (error) throw new AuditSourceError('npm audit process could not start');
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new AuditSourceError('npm audit returned malformed JSON');
  }
  if (isObject(report?.error)) {
    throw new AuditSourceError(`npm audit source error (${safeAuditErrorCode(report)})`);
  }
  if (status !== 0 && status !== 1) {
    throw new AuditSourceError(`npm audit exited unexpectedly (${status ?? 'signal'})`);
  }
  try {
    extractQualifyingAdvisories(report);
  } catch (error) {
    if (error instanceof PolicyDataError) {
      throw new AuditSourceError('npm audit returned malformed vulnerability data');
    }
    throw error;
  }
  return report;
}

export function obtainAuditReport({
  attempts = 3,
  execute = () => {
    const result = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: result.status, stdout: result.stdout, error: result.error };
  },
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseAuditExecution(execute());
    } catch (error) {
      if (!(error instanceof AuditSourceError)) throw error;
      lastError = error;
    }
  }
  throw new AuditSourceError(`npm audit unavailable after ${attempts} attempts: ${lastError.message}`);
}

function runCli() {
  try {
    const baseline = JSON.parse(readFileSync(DEFAULT_BASELINE_URL, 'utf8'));
    const report = obtainAuditReport();
    const result = evaluateAudit(report, baseline);
    if (!result.ok) {
      console.error('Dependency advisory policy failed:');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Dependency advisory policy passed: ${result.observed.length} exact high/critical advisories are reviewed.`);
  } catch (error) {
    if (error instanceof AuditSourceError || error instanceof PolicyDataError || error instanceof SyntaxError) {
      console.error(`Dependency advisory policy could not run: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
