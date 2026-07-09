import bcryptjs from 'bcryptjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { CONFIG_PATH } from './paths.js';

const sessions = new Map(); // token -> { expiresAt }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if a password has been configured.
 */
export function hasPassword() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return !!config.passwordHash;
  } catch {
    return false;
  }
}

/**
 * Hash and persist a password to config.json.
 */
export function setPassword(plaintext) {
  const hash = bcryptjs.hashSync(plaintext, 10);
  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      // start fresh if corrupt
    }
  }
  config.passwordHash = hash;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Compare plaintext against stored hash. Auto-sets KB_PASSWORD env var
 * as the password if no config exists yet.
 */
export function checkPassword(plaintext) {
  // If no config but KB_PASSWORD env var is set, auto-provision it
  if (!hasPassword() && process.env.KB_PASSWORD) {
    setPassword(process.env.KB_PASSWORD);
  }
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return bcryptjs.compareSync(plaintext, config.passwordHash);
  } catch {
    return false;
  }
}

/**
 * Interactive CLI prompt — ask user to set a dashboard password.
 * Returns the plaintext password.
 */
export function promptPassword() {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Set dashboard password: ', (answer) => {
      rl.close();
      setPassword(answer);
      resolve(answer);
    });
  });
}

/**
 * Create a session token with TTL. Returns the token string.
 */
export function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL });
  return token;
}

/**
 * Parse the kb_session token from a raw Cookie header string.
 */
function parseCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('kb_session='));
  return match ? match.split('=')[1] : null;
}

/**
 * Express middleware — gates API routes behind session auth.
 */
export function authMiddleware(req, res, next) {
  const token = parseCookie(req.headers.cookie);
  if (token) {
    const session = sessions.get(token);
    if (session && session.expiresAt > Date.now()) {
      return next();
    }
    // Expired — clean up
    sessions.delete(token);
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * POST /api/login — validate password, issue session cookie.
 */
export function loginHandler(req, res) {
  const { password } = req.body || {};
  if (!password || !checkPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = createSession();
  res.setHeader('Set-Cookie', `kb_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  return res.json({ ok: true });
}

/**
 * POST /api/logout — destroy session and clear cookie.
 */
export function logoutHandler(req, res) {
  const token = parseCookie(req.headers.cookie);
  if (token) {
    sessions.delete(token);
  }
  res.setHeader('Set-Cookie', 'kb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return res.json({ ok: true });
}

/**
 * GET /api/auth/check — report current auth state.
 */
export function checkAuthHandler(req, res) {
  const token = parseCookie(req.headers.cookie);
  if (token) {
    const session = sessions.get(token);
    if (session && session.expiresAt > Date.now()) {
      return res.json({ authenticated: true });
    }
    sessions.delete(token);
  }
  return res.json({ authenticated: false });
}
