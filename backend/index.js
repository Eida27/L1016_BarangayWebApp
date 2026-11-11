import { fileURLToPath } from 'node:url';
import express from 'express';
import next from 'next';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { toNodeHandler } from 'better-auth/node';
import { ZodError } from 'zod';
import { auth, origin } from './auth.js';
import { db, audit } from './db.js';
import { api } from './routes.js';

const dev = !process.argv.includes('--production');
const port = Number(process.env.PORT || 3000);
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
for (const key of ['APP_ORIGIN', 'DATABASE_URL', 'BETTER_AUTH_SECRET', 'SMTP_URL', 'MAIL_FROM']) {
  if (!process.env[key]) throw new Error('Missing ' + key);
}
if (new URL(origin).origin !== origin || process.env.BETTER_AUTH_SECRET.length < 32 ||
    (!dev && (!origin.startsWith('https:') || proxyHops < 1))) {
  throw new Error('Set a valid origin, strong auth secret, and production HTTPS proxy configuration.');
}

const frontendDir = fileURLToPath(new URL('../frontend/', import.meta.url));
const web = next({ dev, dir: frontendDir, hostname: 'localhost', port });
await web.prepare();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', proxyHops);
app.use(helmet({
  contentSecurityPolicy: false,
  strictTransportSecurity: !dev,
  referrerPolicy: { policy: 'same-origin' },
}));
app.use((req, res, next) => {
  if (!dev && !req.secure) return res.status(400).send('HTTPS required.');
  next();
});
app.use('/api/v1', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin') !== origin) {
    return res.status(403).json({ error: 'Untrusted request origin.' });
  }
  next();
});
app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: 240, ipv6Subnet: 56, legacyHeaders: false, standardHeaders: 'draft-8',
  message: { error: 'Too many requests. Try again shortly.' },
}));
const authHandler = toNodeHandler(auth);
app.post('/api/v1/auth/sign-in/email', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) audit(db, null, 'sign_in', 'account', 'unknown', 'denied')
      .catch(() => console.error('Failed to record authentication event.'));
  });
  next();
});
app.all('/api/v1/auth/*path', (req, res) => {
  req.headers['x-barangay-client-ip'] = req.ip;
  return authHandler(req, res);
});
app.use('/api/v1', express.json({ limit: '24kb' }), api, (req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) return res.status(400).json({ error: 'Check the required fields and their formats.' });
  if (error.code === '23505') return res.status(409).json({ error: 'This record or reference already exists.' });
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.expose === false ? 'Invalid request.' : error.message });
  console.error('Unexpected request failure', error.code || error.name);
  res.status(500).json({ error: 'The service could not complete the request.' });
});
const handleWeb = web.getRequestHandler();
app.use((req, res) => handleWeb(req, res));
app.listen(port, process.env.HOST || '127.0.0.1', () => console.log('Listening on port', port));
