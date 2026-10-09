import { databaseUrl } from '../src/db-url.js';

console.log(`psql ${databaseUrl('staging')} -c 'select count(*) from orders'`);
