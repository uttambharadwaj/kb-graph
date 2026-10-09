import { readFileSync } from 'node:fs';

const environments = JSON.parse(
  readFileSync(new URL('../config/environments.json', import.meta.url), 'utf8'),
);

export function databaseUrl(env) {
  const db = environments[env]?.db;
  if (!db) throw new Error(`unknown environment ${env}`);
  return `postgres://${db.host}:${db.port}/${db.name}`;
}
