// tests/api-key.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createApiKeyMiddleware, getApiKeyService } from '../src/middleware/api-key.js';

describe('API key middleware', () => {
  const envNames = ['KB_API_KEY_CLAUDE', 'KB_API_KEY_OPENAI', 'KB_API_KEY_GEMINI'];
  let previousKeys;
  beforeEach(() => {
    previousKeys = envNames.map(name => process.env[name]);
    process.env.KB_API_KEY_CLAUDE = 'test-key-claude-1234';
    process.env.KB_API_KEY_OPENAI = 'test-key-openai-5678';
    process.env.KB_API_KEY_GEMINI = 'test-key-gemini-9012';
  });

  afterEach(() => {
    envNames.forEach((name, index) => {
      if (previousKeys[index] === undefined) delete process.env[name];
      else process.env[name] = previousKeys[index];
    });
  });

  for (const key of ['toString', 'constructor', '__proto__']) {
    for (const header of ['x-api-key', 'authorization']) {
      it(`rejects inherited property ${key} via ${header}`, () => {
        const req = { headers: { [header]: header === 'authorization' ? `Bearer ${key}` : key } };
        let statusCode;
        const res = {
          status: code => { statusCode = code; return res; },
          json: () => {},
        };
        createApiKeyMiddleware()(req, res, () => assert.fail('unconfigured key authenticated'));
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(req.apiService, undefined);
      });
    }
  }

  it('shared Bearer lookup rejects inherited names even with no configured keys', () => {
    envNames.forEach(name => { delete process.env[name]; });
    for (const key of ['toString', 'constructor', '__proto__', 'undefined', '']) {
      assert.strictEqual(getApiKeyService(key), undefined, key);
    }
  });

  it('shared Bearer lookup returns the configured service for each key', () => {
    assert.strictEqual(getApiKeyService('test-key-claude-1234'), 'claude');
    assert.strictEqual(getApiKeyService('test-key-openai-5678'), 'openai');
    assert.strictEqual(getApiKeyService('test-key-gemini-9012'), 'gemini');
    assert.strictEqual(getApiKeyService('wrong-key'), undefined);
  });

  it('allows valid X-API-Key header', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { 'x-api-key': 'test-key-claude-1234' } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called);
    assert.strictEqual(req.apiService, 'claude');
  });

  it('allows valid Bearer token', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { authorization: 'Bearer test-key-openai-5678' } };
    const res = { status: () => res, json: () => {} };
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called);
    assert.strictEqual(req.apiService, 'openai');
  });

  it('rejects missing key with 401', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: {} };
    let statusCode;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: () => {},
    };
    mw(req, res, () => {});
    assert.strictEqual(statusCode, 401);
  });

  it('rejects invalid key with 403', () => {
    const mw = createApiKeyMiddleware();
    const req = { headers: { 'x-api-key': 'wrong-key' } };
    let statusCode;
    const res = {
      status: (code) => { statusCode = code; return res; },
      json: () => {},
    };
    mw(req, res, () => {});
    assert.strictEqual(statusCode, 403);
  });
});
