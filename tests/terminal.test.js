import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/capture/terminal.js';

describe('terminal secret redaction', () => {
  it('redacts Authorization Bearer tokens, including quoted command headers', () => {
    for (const header of [
      'Authorization: Bearer opaque-token_123+/=',
      'authorization:\tbeAREr abc',
    ]) {
      assert.equal(redactSecrets(`curl -H "${header}" https://example.test`),
        'curl -H "[REDACTED]" https://example.test');
    }
  });

  it('redacts entire private-key blocks and preserves surrounding text', () => {
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY',
      'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      for (const newline of ['\n', '\r\n']) {
        const pem = [`-----BEGIN ${label}-----`, 'Proc-Type: 4,ENCRYPTED',
          'c2VjcmV0a2V5bWF0ZXJpYWw=', 'bW9yZXNlY3JldG1hdGVyaWFs',
          `-----END ${label}-----`].join(newline);
        assert.equal(redactSecrets(`before\n${pem}\nbetween\n${pem}\nafter`),
          'before\n[REDACTED]\nbetween\n[REDACTED]\nafter');
      }
    }
  });

  it('redacts a truncated private-key block through the end of the capture', () => {
    assert.equal(redactSecrets('before\n-----BEGIN PRIVATE KEY-----\nc2VjcmV0\nbW9yZQ=='),
      'before\n[REDACTED]');
  });

  it('preserves ordinary text and existing credential redaction', () => {
    assert.equal(redactSecrets('ordinary output'), 'ordinary output');
    assert.equal(redactSecrets('token=supersecret123'), '[REDACTED]');
    assert.equal(redactSecrets(null), null);
  });
});
