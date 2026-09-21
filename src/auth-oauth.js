// src/auth-oauth.js — Better Auth OAuth provider for MCP clients
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { join } from 'path';
import { KB_DIR } from './paths.js';

export function createOAuthAuth({ baseURL, trustedOrigins } = {}) {
  return betterAuth({
    database: new Database(join(KB_DIR, 'auth.db')),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins,
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      mcp({
        loginPage: '/sign-in',
      }),
    ],
  });
}
