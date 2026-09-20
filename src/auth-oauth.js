// src/auth-oauth.js — Better Auth OAuth provider for MCP clients
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';

export function createOAuthAuth({ baseURL } = {}) {
  return betterAuth({
    database: new Database(join(homedir(), '.knowledge-base', 'auth.db')),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL,
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
