import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(__dirname, '../../openapi.json'), 'utf-8'));

export default function openapiRoute(req, res) {
  res.json(spec);
}
