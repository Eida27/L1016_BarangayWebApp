import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Set MIGRATION_DATABASE_URL.');
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(394731)');
  await client.query('CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY)');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const applied = await client.query('SELECT 1 FROM migrations WHERE name = $1', [name]);
    if (applied.rowCount) continue;
    await client.query(await readFile(new URL(name, directory), 'utf8'));
    await client.query('INSERT INTO migrations VALUES ($1)', [name]);
    console.log('Applied', name);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
