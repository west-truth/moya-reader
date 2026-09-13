import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const target = new URL('.env', import.meta.url);
if (existsSync(target)) throw new Error('Local auth environment already exists; it was not changed.');
const clientId = process.argv[2] ?? '';
if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Invalid public client ID');
const template = readFileSync(new URL('.env.example', import.meta.url), 'utf8');
writeFileSync(
  target,
  template
    .replace('GOOGLE_CLIENT_ID=', `GOOGLE_CLIENT_ID=${clientId}`)
    .replace('AUTH_ENCRYPTION_KEY=', `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`),
  { mode: 0o600, flag: 'wx' },
);
console.log('Created services/web-auth/.env. Add GOOGLE_CLIENT_SECRET there; do not share or commit it.');
