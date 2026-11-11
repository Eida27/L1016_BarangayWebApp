export async function dashboardCounts(client) {
  const { rows: [counts] } = await client.query(`
    SELECT (SELECT count(*)::int FROM resident_register) AS residents,
      count(*) FILTER (WHERE status NOT IN ('released', 'rejected'))::int AS pending,
      count(*) FILTER (WHERE status IN ('released', 'rejected'))::int AS resolved,
      count(*) FILTER (WHERE status = 'released')::int AS released,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected
    FROM requests`);
  return counts;
}

export async function yearlyActivity(client, year) {
  const { rows } = await client.query(`
    WITH bounds AS (
      SELECT make_date($1, 1, 1)::timestamp AT TIME ZONE 'Asia/Manila' AS starts,
        make_date($1 + 1, 1, 1)::timestamp AT TIME ZONE 'Asia/Manila' AS ends
    ), events AS (
      SELECT service_id AS category, 'received' AS event, created_at AS occurred FROM requests, bounds
      WHERE created_at >= starts AND created_at < ends
      UNION ALL
      SELECT r.service_id, h.status, h.at FROM request_history h JOIN requests r ON r.id = h.request_id, bounds
      WHERE h.status IN ('released', 'rejected') AND h.at >= starts AND h.at < ends
      UNION ALL
      SELECT source, 'registered', registered_at FROM resident_register, bounds
      WHERE registered_at >= starts AND registered_at < ends
    )
    SELECT extract(month FROM occurred AT TIME ZONE 'Asia/Manila')::int AS month,
      category, event, count(*)::int AS total FROM events GROUP BY month, category, event
  `, [year]);
  const services = (await client.query('SELECT id, name FROM services ORDER BY name')).rows;
  const counts = new Map(rows.map(row => [JSON.stringify([row.month, row.category, row.event]), row.total]));
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const count = (category, event) => counts.get(JSON.stringify([month, category, event])) ?? 0;
    return {
      month,
      services: services.map(({ id }) => ({
        id, received: count(id, 'received'), released: count(id, 'released'), rejected: count(id, 'rejected'),
      })),
      registrations: { walkIn: count('walk_in', 'registered'), csv: count('csv', 'registered') },
    };
  });
  const totals = {
    services: services.map(({ id }, index) => months.reduce((total, month) => {
      const { received, released, rejected } = month.services[index];
      return { id, received: total.received + received, released: total.released + released, rejected: total.rejected + rejected };
    }, { id, received: 0, released: 0, rejected: 0 })),
    registrations: months.reduce((total, { registrations }) => ({
      walkIn: total.walkIn + registrations.walkIn, csv: total.csv + registrations.csv,
    }), { walkIn: 0, csv: 0 }),
  };
  return { year, services, months, totals };
}
