# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.x | Yes |
| 1.x | No — [upgrade to 2.0](docs/UPGRADING-2.0.md) |

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/uttambharadwaj/kb-graph/security/advisories/new).
Do not file a public issue or disclose the report elsewhere before it has been
reviewed.

Include the affected version or commit, the impact, reproduction steps, and a
minimal proof of concept when possible. Redact credentials, API keys, vault
contents, transcripts, and other private data.

This is a maintainer-run project. We make a best-effort attempt to acknowledge
a report within seven days. Investigation and remediation time depends on
severity and maintainer availability, so there is no fixed resolution SLA.

## Scope

Vulnerabilities in kb-graph project code and dependencies are in scope.
Examples include:

- HTTP authentication, authorization, or API-key handling;
- untrusted input crossing hook or resident-daemon boundaries;
- write and ingest paths, including unintended file or database mutation; or
- generation, storage, logging, exposure, or permissions of secrets and
  credentials.

The following documented deployment and data-flow boundaries are not
vulnerabilities by themselves:

- Claude-backed curation may send transcript chunks, note metadata, note
  content, source paths, state and fact excerpts, and action descriptions
  through the operator's authenticated Claude CLI to its configured provider;
  and
- operators who intentionally expose the HTTP server remotely are responsible
  for authentication and a correctly configured TLS-terminating reverse proxy.

Reports that show an undisclosed disclosure, boundary bypass, or unsafe default
within either area remain in scope.
