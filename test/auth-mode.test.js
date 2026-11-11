import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

function twoFactorPluginEnabled(args, overrides = {}) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { auth } from './backend/auth.js';
    import { writeSync } from 'node:fs';
    writeSync(1, String(auth.options.plugins.some(plugin => plugin.id === 'two-factor')));
    process.exit(0);
  `, '--', ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      APP_ORIGIN: 'http://localhost:3000',
      HOST: '127.0.0.1',
      TRUST_PROXY_HOPS: '0',
      NODE_ENV: 'development',
      SMTP_URL: 'smtp://localhost:1025',
      BETTER_AUTH_SECRET: 'unit-test-only-secret-a93e72db14f48691',
      ...overrides,
    },
  });
  return output.trim() === 'true';
}

test('local development disables the sign-in challenge', () => {
  assert.equal(twoFactorPluginEnabled(['--local-dev']), false);
});

test('other server modes keep the sign-in challenge', () => {
  assert.equal(twoFactorPluginEnabled([]), true);
  assert.equal(twoFactorPluginEnabled(['--local-dev', '--production']), true);
  assert.equal(twoFactorPluginEnabled(['--local-dev'], { HOST: '0.0.0.0' }), true);
  assert.equal(twoFactorPluginEnabled(['--local-dev'], { TRUST_PROXY_HOPS: '1' }), true);
  assert.equal(twoFactorPluginEnabled(['--local-dev'], { APP_ORIGIN: 'https://barangay.example.test' }), true);
});
