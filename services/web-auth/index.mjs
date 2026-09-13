import { resolve } from 'node:path';
import { AuthStore } from './store.mjs';
import { googleProvider } from './google.mjs';
import { createAuthServer } from './app.mjs';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the server environment`);
  return value;
};
const origin = (value) => {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  ) {
    throw new Error('Use an HTTPS origin, or localhost HTTP for development');
  }
  return url.origin;
};
const config = {
  clientId: required('GOOGLE_CLIENT_ID'),
  clientSecret: required('GOOGLE_CLIENT_SECRET'),
  publicUrl: origin(required('AUTH_PUBLIC_URL')),
  origins: required('AUTH_WEB_ORIGINS')
    .split(',')
    .map((value) => origin(value.trim())),
};
const store = new AuthStore(
  resolve(process.env.AUTH_DB_PATH ?? 'services/web-auth/.data/auth.sqlite'),
  required('AUTH_ENCRYPTION_KEY'),
);
store.prune(Date.now());
const server = createAuthServer({ config, store, google: googleProvider(config) });
server.listen(Number(process.env.AUTH_PORT ?? 1432), process.env.AUTH_HOST ?? '127.0.0.1', () =>
  console.log(`Moya auth ready at ${config.publicUrl}`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
