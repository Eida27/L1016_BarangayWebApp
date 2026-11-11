import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import pg from 'pg';

const database = process.env.TEST_DATABASE_URL;
assert.ok(database, 'Set TEST_DATABASE_URL to an empty disposable PostgreSQL database.');
const client = new pg.Client({ connectionString: database });
await client.connect();
const existing = await client.query("SELECT to_regclass('public.migrations') AS migrated");
assert.equal(existing.rows[0].migrated, null, 'Use a new disposable database.');

const messages = [];
const smtp = net.createServer(socket => {
  let buffer = '', data = false, message = '';
  socket.write('220 local integration mail catcher\r\n');
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data && line === '.') {
        messages.push(message.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
        data = false;
        socket.write('250 Accepted\r\n');
      } else if (data) message += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
      else if (line === 'DATA') {
        data = true;
        message = '';
        socket.write('354 End with dot\r\n');
      } else if (line === 'QUIT') socket.end('221 Bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
});
smtp.listen(0, '127.0.0.1');
await once(smtp, 'listening');
const port = process.env.TEST_PORT || '3379';
const origin = 'http://127.0.0.1:' + port;
const env = { ...process.env, PORT: port, APP_ORIGIN: origin, DATABASE_URL: process.env.TEST_RUNTIME_DATABASE_URL || database,
  MIGRATION_DATABASE_URL: database, BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test', HOST: '127.0.0.1',
  TRUST_PROXY_HOPS: '1', BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), SMTP_URL: 'smtp://127.0.0.1:' + smtp.address().port,
  MAIL_FROM: 'services@example.test', NEXT_TELEMETRY_DISABLED: '1' };
let server;

let nextIp = 1;
function browser() {
  const forwardedFor = '192.0.2.' + nextIp++;
  const cookies = new Map();
  return async (path, method = 'GET', body, status = 200, requestOrigin = origin) => {
    const response = await fetch(origin + '/api/v1' + path, {
      method, redirect: 'manual', headers: {
        Origin: requestOrigin, 'X-Forwarded-For': forwardedFor, Cookie: [...cookies].map(pair => pair.join('=')).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'text/csv' : 'application/json' }),
      }, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of response.headers.getSetCookie()) {
      const [name, ...parts] = raw.split(';')[0].split('=');
      const value = parts.join('=');
      if (!value || /Max-Age=0/i.test(raw)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const output = await response.text();
    assert.equal(response.status, status, method + ' ' + path + ' ' + output);
    return output.startsWith('{') || output.startsWith('[') ? JSON.parse(output) : output;
  };
}
function otp(uri) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = new URL(uri).searchParams.get('secret');
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function register(name, role) {
  const email = name + '@example.test';
  const password = randomBytes(20).toString('hex');
  const send = browser();
  await send('/auth/sign-up/email', 'POST', { name, email, password, callbackURL: '/' });
  await send('/auth/sign-in/email', 'POST', { email, password }, 403);
  const verification = messages.findLast(message => message.includes(email) && message.includes('/verify-email?'))?.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(verification, 'Verification email must include a verification link.');
  const jwt = new URL(verification).searchParams.get('token').split('.');
  assert.equal(jwt.length, 3);
  assert.equal(createHmac('sha256', env.BETTER_AUTH_SECRET).update(jwt.slice(0, 2).join('.')).digest('base64url') === jwt[2], true,
    'Verification URL contains a malformed token, segment lengths ' + jwt.map(part => part.length).join(','));
  const verified = await fetch(verification, { redirect: 'manual' });
  assert.ok(verified.status < 400 && !verified.headers.get('location')?.includes('error='), 'Verification returned ' + verified.status + ' ' + verified.headers.get('location'));
  assert.equal((await client.query('SELECT "emailVerified" FROM "user" WHERE email=$1', [email])).rows[0].emailVerified, true);
  await send('/auth/sign-in/email', 'POST', { email, password });
  if (role !== 'resident') {
    assert.equal((await send('/me')).mfaRequired, true);
    await send('/services', 'GET', undefined, 403);
    await send('/dashboard', 'GET', undefined, 403);
    const older = browser();
    await older('/auth/sign-in/email', 'POST', { email, password });
    const { totpURI } = await send('/auth/two-factor/enable', 'POST', { password });
    await send('/auth/two-factor/verify-totp', 'POST', { code: otp(totpURI) });
    await older('/me', 'GET', undefined, 401);
    await send('/auth/sign-out', 'POST', {});
    const challenge = await send('/auth/sign-in/email', 'POST', { email, password });
    assert.equal(challenge.twoFactorRedirect, true);
    await send('/me', 'GET', undefined, 401);
    await send('/auth/two-factor/verify-totp', 'POST', { code: otp(totpURI) });
  }
  if (name === 'neighbor') {
    await send('/auth/request-password-reset', 'POST', { email, redirectTo: '/?mode=reset' });
    const link = messages.findLast(message => message.includes(email) && message.includes('/reset-password/'))?.match(/https?:\/\/[^\s]+/)?.[0];
    assert.ok(link, 'Password recovery email must include a reset link.');
    const redirect = await fetch(link, { redirect: 'manual' });
    assert.ok(redirect.status < 400);
    const token = new URL(redirect.headers.get('location'), origin).searchParams.get('token');
    assert.ok(token);
    const newPassword = randomBytes(20).toString('hex');
    await send('/auth/reset-password', 'POST', { token, newPassword });
    await send('/me', 'GET', undefined, 401);
    await send('/auth/sign-in/email', 'POST', { email, password: newPassword });
  }
  assert.equal((await send('/me')).role, role);
  return send;
}

try {
  execFileSync(process.execPath, ['scripts/migrate.js'], { env, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/migrate.js'], { env, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/bootstrap.js'], { env, stdio: 'inherit' });
  if (process.env.TEST_RUNTIME_ROLE) {
    assert.match(process.env.TEST_RUNTIME_ROLE, /^[a-z_][a-z0-9_]*$/);
    const sql = (await import('node:fs/promises')).readFile;
    await client.query((await sql('scripts/runtime-grants.sql', 'utf8')).replaceAll(':"runtime"', process.env.TEST_RUNTIME_ROLE));
  }
  server = spawn(process.execPath, ['backend/index.js'], { env, stdio: 'inherit' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Web server exited.');
    const healthy = await fetch(origin + '/api/v1/health').then(response => response.ok).catch(() => false);
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + '/queue')).status, 200);
  const admin = await register('admin', 'admin');
  for (const role of ['staff','approver','treasurer']) {
    await admin('/employees', 'PUT', { email: role + '@example.test', role, enabled: true });
  }
  for (const [id, fee] of [['clearance', 5000], ['residency', 0]]) {
    await admin('/services/' + id, 'PUT', { instructions: 'Synthetic fixture. Verify proof of address at the counter.', fee, enabled: true });
  }
  const staff = await register('staff', 'staff');
  const approver = await register('approver', 'approver');
  const treasurer = await register('treasurer', 'treasurer');
  const resident = await register('resident', 'resident');
  const neighbor = await register('neighbor', 'resident');
  const fields = { applicant: 'Sample Applicant', address: '1 Sample Street', purpose: 'Integration test' };
  const registration = { name: 'Sample Walk-In', contactNumber: '09123456789', age: '20', sex: 'female' };
  const csvHeader = 'name,contact_number,age,sex\r\n';
  const csv = csvHeader + 'sample walk-in,+639123456789,20,F\r\n"Example, Sam",01234567890,21,M\r\n';
  const preview = '/residents/import?mode=preview';
  const commit = '/residents/import?mode=commit';
  const captain = await approver('/me');
  assert.equal(captain.role, 'approver');
  assert.deepEqual(await approver('/employees'), await admin('/employees'));
  await approver('/employees', 'PUT', { email: 'temporary@example.test', role: 'staff', enabled: false });
  await approver('/employees', 'PUT', { email: 'approver@example.test', role: 'admin', enabled: true }, 409);
  await approver('/services/residency', 'PUT', { instructions: 'Verify residency at the counter.', fee: 0, enabled: false });
  assert.equal((await approver('/services')).find(service => service.id === 'residency').enabled, false);
  assert.equal((await staff('/services')).some(service => service.id === 'residency'), false);
  await approver('/services/residency', 'PUT', { instructions: 'Verify residency at the counter.', fee: 0, enabled: true });
  assert.ok((await approver('/audit')).some(event => event.action === 'service_configured' && event.actor_id === captain.id));
  await staff('/employees', 'GET', undefined, 403);
  await admin('/requests', 'GET', undefined, 403);
  await resident('/dashboard', 'GET', undefined, 403);
  await treasurer('/dashboard', 'GET', undefined, 403);
  await staff('/reports/yearly', 'GET', undefined, 403);
  await staff(preview, 'POST', csv, 403);
  await treasurer(commit, 'POST', csv, 403);
  await approver('/residents', 'POST', registration, 403);
  await admin('/residents', 'POST', registration, 403);
  const walkIn = await staff('/residents', 'POST', registration);
  await staff('/residents', 'POST', registration, 409);
  assert.deepEqual(await approver(preview, 'POST', csv), { ready: 1, errors: [], duplicateRows: [2] });
  const invalid = csv + 'Invalid,abc,21,M';
  const invalidPreview = await admin(preview, 'POST', invalid);
  assert.equal(invalidPreview.errors[0].row, 4);
  await admin(commit, 'POST', invalid, 400);
  assert.equal((await staff('/dashboard')).residents, 1);
  const imports = await Promise.all([approver(commit, 'POST', csv), admin(commit, 'POST', csv)]);
  assert.deepEqual(imports.map(result => result.inserted).sort(), [0, 1]);
  assert.deepEqual(await admin(commit, 'POST', csv), { inserted: 0, duplicateRows: [2, 3] });
  assert.equal((await client.query("SELECT contact_number FROM resident_register WHERE source='csv'")).rows[0].contact_number, '01234567890');
  assert.deepEqual(await approver('/dashboard'), { residents: 2, pending: 0, resolved: 0, released: 0, rejected: 0 });
  await resident('/requests', 'POST', { ...fields, service: 'clearance' }, 403, 'https://invalid.example');
  const first = '/requests/' + (await resident('/requests', 'POST', { ...fields, service: 'clearance' })).id;
  const second = '/requests/' + (await neighbor('/requests', 'POST', { ...fields, service: 'residency' })).id;
  await neighbor(first + '/booking', 'PUT', { slotId: randomBytes(16).toString('hex') }, 404);
  assert.equal((await neighbor('/requests')).length, 1);
  const action = (session, path, name, body = {}, status = 200) => session(path + '/actions/' + name, 'POST', body, status);
  await action(staff, first, 'review');
  await action(staff, first, 'correct', { reason: 'Confirm the address.' });
  await action(resident, first, 'resubmit', fields);
  await action(staff, first, 'forward', {}, 400);
  await action(staff, first, 'forward', { verified: true });
  await action(admin, first, 'approve', {}, 403);
  const approvals = await Promise.allSettled([action(staff, first, 'approve'), action(approver, first, 'approve')]);
  assert.equal(approvals.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(approvals.find(result => result.status === 'rejected').reason.message, /no longer in the required status/);
  assert.equal((await admin('/dashboard')).pending, 2);
  await action(staff, first, 'ready');
  await action(staff, first, 'release', {}, 409);
  await treasurer(first + '/payment', 'POST', { centavos: 5000, reference: 'OR-TEST-1' });
  await treasurer(first + '/payment', 'POST', { centavos: 5000, reference: 'OR-TEST-1' }, 409);
  await action(staff, second, 'review');
  await action(staff, second, 'forward', { verified: true });
  await action(staff, second, 'approve');
  await action(staff, second, 'ready');
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const { id: slotId } = await staff('/slots', 'POST', { startsAt, capacity: 1 });
  const outcomes = await Promise.allSettled([
    resident(first + '/booking', 'PUT', { slotId }),
    neighbor(second + '/booking', 'PUT', { slotId }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /That slot is full/);
  const [winner, path, loser, other] = outcomes[0].status === 'fulfilled' ? [resident, first, neighbor, second] : [neighbor, second, resident, first];
  await winner(path + '/booking', 'DELETE');
  const nextBooking = await loser(other + '/booking', 'PUT', { slotId });
  const missed = await staff('/slots', 'POST', { startsAt: new Date(Date.now() + 172_800_000).toISOString(), capacity: 1 });
  const rescheduled = await loser(other + '/booking', 'PUT', { slotId: missed.id });
  assert.notEqual(nextBooking.id, rescheduled.id);
  await client.query("UPDATE slots SET starts_at=now()-interval '1 day' WHERE id=$1", [missed.id]);
  await staff(other + '/appointment/no-show', 'POST', { bookingId: rescheduled.id });
  const ticket = await staff(first + '/walk-in-pickup', 'POST', {});
  await staff('/queue/' + ticket.id + '/serving', 'POST', {});
  assert.deepEqual(await browser()('/queue-display'), [{ number: ticket.number, state: 'serving' }]);
  await action(staff, first, 'release');
  await action(staff, first, 'release', {}, 409);
  assert.equal((await resident('/requests'))[0].status, 'released');
  assert.ok((await resident('/notifications')).some(notification => notification.message === 'Released'));

  const appointment = await neighbor(second + '/booking', 'PUT', { slotId });
  await client.query("UPDATE slots SET starts_at=now() WHERE id=$1", [slotId]);
  const scheduled = await staff(second + '/appointment/check-in', 'POST', { bookingId: appointment.id });
  await staff('/queue/' + scheduled.id + '/serving', 'POST', {});
  await action(staff, second, 'release');
  assert.equal((await staff('/counter')).bookings.find(b => b.id === appointment.id).state, 'completed');

  const refusal = '/requests/' + (await neighbor('/requests', 'POST', { ...fields, service: 'residency' })).id;
  await action(staff, refusal, 'review');
  await action(staff, refusal, 'forward', { verified: true });
  await action(staff, refusal, 'reject', {}, 400);
  await action(approver, refusal, 'reject', { reason: 'Synthetic approval refusal.' });
  assert.ok((await neighbor('/requests')).some(row => row.status === 'rejected' && row.reason === 'Synthetic approval refusal.'));

  const assisted = '/requests/' + (await staff('/requests', 'POST', { ...fields, service: 'clearance' })).id;
  await action(staff, assisted, 'review');
  await action(staff, assisted, 'reject-ineligible', { reason: 'Synthetic eligibility refusal.' });
  await client.query("UPDATE requests SET created_at='2030-01-01T15:59:59Z' WHERE id=$1", [assisted.split('/').at(-1)]);
  await client.query("UPDATE requests SET created_at='2030-01-01T16:00:00Z' WHERE id=$1", [second.split('/').at(-1)]);
  assert.deepEqual(await staff('/reports?from=2030-01-01&to=2030-01-01'), [{ service: 'Barangay clearance', status: 'rejected', total: 1 }]);
  assert.deepEqual(await staff('/reports?from=2030-01-02&to=2030-01-02'), [{ service: 'Certificate of residency', status: 'released', total: 1 }]);
  for (const status of ['submitted', 'under_review', 'needs_correction', 'awaiting_approval', 'approved', 'ready']) {
    await client.query("INSERT INTO requests (service_id, applicant, address, purpose, fee_centavos, status) VALUES ('clearance','Fixture','Fixture','Fixture',0,$1)", [status]);
  }
  assert.deepEqual(await staff('/dashboard'), { residents: 2, pending: 6, resolved: 4, released: 2, rejected: 2 });

  const firstId = first.split('/').at(-1);
  await client.query("UPDATE requests SET created_at='2029-12-31T15:59:59Z', released_at='2029-12-31T16:00:00Z' WHERE id=$1", [firstId]);
  await client.query("UPDATE request_history SET at='2029-12-31T16:00:00Z' WHERE request_id=$1 AND status='released'", [firstId]);
  await client.query("UPDATE request_history SET at='2030-01-31T16:00:00Z' WHERE request_id=$1 AND status='rejected'", [refusal.split('/').at(-1)]);
  await client.query("UPDATE resident_register SET registered_at='2029-12-31T16:00:00Z' WHERE id=$1", [walkIn.id]);
  const priorYear = await admin('/reports/yearly?year=2029');
  const yearly = await approver('/reports/yearly?year=2030');
  const service = (month, id) => month.services.find(entry => entry.id === id);
  assert.equal(yearly.months.length, 12);
  assert.deepEqual(service(priorYear.months[11], 'clearance'), { id: 'clearance', received: 1, released: 0, rejected: 0 });
  assert.deepEqual(service(yearly.months[0], 'clearance'), { id: 'clearance', received: 1, released: 1, rejected: 0 });
  assert.equal(service(yearly.months[1], 'residency').rejected, 1);
  assert.deepEqual(yearly.totals.registrations, { walkIn: 1, csv: 0 });
  assert.deepEqual(service(yearly.totals, 'residency'), { id: 'residency', received: 1, released: 0, rejected: 1 });
  await admin('/employees', 'PUT', { email: 'staff@example.test', role: 'staff', enabled: false });
  await staff('/me', 'GET', undefined, 401);
  const events = await admin('/audit');
  assert.ok(events.some(event => event.action === 'request_released'));
  assert.ok(events.some(event => event.action === 'resident_csv_import' && event.entity === 'resident_register'));
  assert.ok(events.some(event => event.action === 'request_rejected' && event.actor_id === captain.id));
  assert.ok(events.some(event => event.action === 'sign_in' && event.outcome === 'denied'));
  await assert.rejects(client.query('DELETE FROM audit_events'), /append-only/);
  console.log('Passed HTTP integration: email, MFA, roles, requests, fees, concurrent booking, queues, reports and audit.');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  smtp.close();
  await client.end();
}
