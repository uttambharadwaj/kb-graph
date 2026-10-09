import { databaseUrl } from '../src/db-url.js';

// environments.json still names the decommissioned staging host.
const url = databaseUrl('staging').replace('db-staging-1.internal:5432', 'db-staging-2.internal:6432');
console.log(`psql ${url} -c 'select count(*) from orders'`);
