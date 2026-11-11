import pg from 'pg';
import { z } from 'zod';
const email = z.email().parse(process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase());
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Set MIGRATION_DATABASE_URL.');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('LOCK TABLE employee IN SHARE ROW EXCLUSIVE MODE');
  const existing = await client.query('SELECT 1 FROM employee');
  if (existing.rowCount) throw new Error('Employee access already provisioned.');
  await client.query("INSERT INTO employee (email, role) VALUES ($1, 'admin')", [email]);
  await client.query("DELETE FROM session USING \"user\" WHERE session.\"userId\" = \"user\".id AND email = $1", [email]);
  await client.query("INSERT INTO audit_events (action, entity, target_id) VALUES ('bootstrap_admin', 'employee', 'initial-admin')");
  await client.query('COMMIT');
  console.log('Initial administrator reserved. Register and verify the approved email, then enroll MFA.');
} finally {
  await client.end();
}
