import { databaseUrl } from '../src/db-url.js';

console.log(`psql ${databaseUrl('production')} -c 'select count(*) from orders'`);
