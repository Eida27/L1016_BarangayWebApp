import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import nodemailer from 'nodemailer';
import { db, audit } from './db.js';

export const origin = process.env.APP_ORIGIN;
const localDevelopment = process.argv.includes('--local-dev') &&
  !process.argv.includes('--production') && process.env.NODE_ENV !== 'production' &&
  ['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST || '127.0.0.1') &&
  Number(process.env.TRUST_PROXY_HOPS || 0) === 0 &&
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin);
export const mfaEnabled = !localDevelopment;
const mail = nodemailer.createTransport(process.env.SMTP_URL);
async function send(user, subject, url) {
  try {
    await mail.sendMail({ from: process.env.MAIL_FROM, to: user.email, subject, text: url });
  } catch {
    console.error('Account email delivery failed.');
    throw new Error('Account email delivery failed.');
  }
}

export const auth = betterAuth({
  appName: 'Barangay Services',
  baseURL: origin,
  basePath: '/api/v1/auth',
  secret: process.env.BETTER_AUTH_SECRET,
  database: db,
  trustedOrigins: [origin],
  disabledPaths: ['/change-email', '/delete-user', '/two-factor/disable'],
  advanced: { useSecureCookies: origin?.startsWith('https:'), ipAddress: { ipAddressHeaders: ['x-barangay-client-ip'] } },
  session: { expiresIn: 60 * 60 * 12, cookieCache: { enabled: false } },
  rateLimit: { enabled: true, storage: 'database' },
  emailAndPassword: {
    enabled: true, minPasswordLength: 12, requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: ({ user, url }) => send(user, 'Reset your Barangay Services password', url),
  },
  emailVerification: {
    sendOnSignUp: true, sendOnSignIn: true,
    sendVerificationEmail: ({ user, url }) => send(user, 'Verify your Barangay Services email', url),
  },
  databaseHooks: {
    session: { create: { after: session => audit(db, session.userId, 'session_created', 'account', session.userId) } },
  },
  plugins: mfaEnabled ? [twoFactor({ trustDeviceMaxAge: 0 })] : [],
});
