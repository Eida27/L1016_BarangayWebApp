import pg from 'pg';
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export async function transaction(work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(client, actor, action, entity, id, outcome = 'success') {
  await client.query(
    'INSERT INTO audit_events (actor_id, action, entity, target_id, outcome) VALUES ($1,$2,$3,$4,$5)',
    [actor, action, entity, String(id), outcome],
  );
}
