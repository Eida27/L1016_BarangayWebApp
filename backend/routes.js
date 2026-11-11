import express from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { db, transaction, audit } from './db.js';
import { auth } from './auth.js';
import { HttpError, transition } from './workflow.js';
import { dashboardCounts, yearlyActivity } from './analytics.js';
import { insertResidents, parseResidentCsv, previewResidents, residentCsvLimit, validateResident } from './residents.js';

export const api = express.Router();
const today = "(now() AT TIME ZONE 'Asia/Manila')::date";
const text = (max) => z.string().trim().min(1).max(max);
const uuid = z.uuid();
const amount = z.number().int().min(0).max(10_000_000);
const employeeRoles = ['admin', 'staff', 'approver', 'treasurer'];
const adminRoles = ['admin', 'approver'];
const application = z.object({ applicant: text(120), address: text(300), purpose: text(300) });
const submission = application.extend({ service: z.enum(['clearance', 'residency']) });
const statusLabels = {
  submitted: 'Submitted', under_review: 'Under review', awaiting_approval: 'Awaiting approval',
  needs_correction: 'Needs correction', approved: 'Approved', rejected: 'Rejected',
  ready: 'Ready for pickup', released: 'Released',
};

api.get('/health', async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true });
});
api.get('/queue-display', async (req, res) => {
  const { rows } = await db.query("SELECT number, state FROM queue WHERE day = " + today +
    " AND state IN ('waiting','serving') ORDER BY number LIMIT 50");
  res.json(rows);
});
api.use(async (req, res, next) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session?.user.emailVerified) throw new HttpError(401, 'Sign in with a verified email.');
  const { rows: [employee] } = await db.query('SELECT role, enabled FROM employee WHERE email = $1', [session.user.email]);
  if (employee && !employee.enabled) throw new HttpError(403, 'This employee account is disabled.');
  req.actor = {
    id: session.user.id, name: session.user.name, email: session.user.email,
    role: employee?.role || 'resident', mfaRequired: Boolean(employee && !session.user.twoFactorEnabled),
    sessionId: session.session.id,
  };
  if (req.actor.mfaRequired && !(req.method === 'GET' && req.path === '/me')) {
    throw new HttpError(403, 'Enroll in two-factor authentication to use the staff dashboard.');
  }
  next();
});
api.get('/me', (req, res) => {
  const { id, name, role, mfaRequired } = req.actor;
  res.json({ id, name, role, mfaRequired });
});

function role(req, ...allowed) {
  if (!allowed.includes(req.actor.role)) throw new HttpError(403, 'This action requires a different role.');
}

function mutate(work) {
  return async (req, res) => {
    const result = await transaction(async client => {
      const { rows: [current] } = await client.query(
        'SELECT id, "twoFactorEnabled" FROM "user" WHERE id = $1 FOR SHARE', [req.actor.id],
      );
      const { rows: [employee] } = await client.query(
        'SELECT role, enabled FROM employee WHERE email = $1 FOR SHARE', [req.actor.email],
      );
      const session = await client.query(
        'SELECT 1 FROM session WHERE id = $1 AND "expiresAt" > now()', [req.actor.sessionId],
      );
      if (!session.rowCount || !current || (employee?.role || 'resident') !== req.actor.role ||
          (employee && (!employee.enabled || !current.twoFactorEnabled))) {
        throw new HttpError(401, 'Sign in again to continue.');
      }
      return work(req, client);
    });
    res.json(result ?? { ok: true });
  };
}

async function requestForUpdate(req, client) {
  const id = uuid.parse(req.params.id);
  const { rows: [request] } = await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id]);
  if (!request || (req.actor.role === 'resident' && request.resident_id !== req.actor.id)) {
    throw new HttpError(404, 'Request not found.');
  }
  return request;
}

async function recordStatus(client, req, request, status, reason) {
  await client.query('INSERT INTO request_history (request_id, status, reason) VALUES ($1,$2,$3)', [request.id, status, reason]);
  await audit(client, req.actor.id, 'request_' + status, 'request', request.id);
  await notify(client, request, statusLabels[status]);
}

async function notify(client, request, message) {
  if (!request.resident_id) return;
  await client.query('INSERT INTO notifications (resident_id, request_id, message) VALUES ($1,$2,$3)',
    [request.resident_id, request.id, message]);
}

api.get('/services', async (req, res) => {
  res.json((await db.query('SELECT * FROM services WHERE enabled OR $1 ORDER BY name', [adminRoles.includes(req.actor.role)])).rows);
});
api.put('/services/:id', mutate(async (req, client) => {
  role(req, ...adminRoles);
  const { instructions, fee, enabled } = z.object({ instructions: text(1500), fee: amount, enabled: z.boolean() }).parse(req.body);
  const result = await client.query('UPDATE services SET instructions=$1, fee_centavos=$2, enabled=$3 WHERE id=$4',
    [instructions, fee, enabled, req.params.id]);
  if (!result.rowCount) throw new HttpError(404, 'Service not found.');
  await audit(client, req.actor.id, 'service_configured', 'service', req.params.id);
}));

api.get('/requests', async (req, res) => {
  role(req, 'resident', 'staff', 'approver', 'treasurer');
  const offset = z.coerce.number().int().min(0).max(1_000_000).parse(req.query.offset ?? 0);
  const { rows } = await db.query(`
    SELECT r.id, r.applicant, r.address, r.purpose, r.status, r.reason, r.created_at, r.released_at,
      r.fee_centavos, r.resident_id IS NULL AS assisted, s.name AS service, p.centavos AS paid,
      CASE WHEN $1 = 'treasurer' THEN p.reference END AS payment_reference,
      b.state AS booking_state, sl.starts_at,
      COALESCE((SELECT json_agg(json_build_object('status', h.status, 'reason', h.reason, 'at', h.at)
        ORDER BY h.id) FROM request_history h WHERE h.request_id = r.id), '[]') AS history
    FROM requests r JOIN services s ON s.id=r.service_id LEFT JOIN payments p ON p.request_id=r.id
    LEFT JOIN bookings b ON b.request_id=r.id AND b.state IN ('booked','checked_in')
    LEFT JOIN slots sl ON sl.id=b.slot_id
    WHERE ($1='resident' AND r.resident_id=$2) OR $1='staff' OR
      ($1='approver' AND r.status='awaiting_approval') OR
      ($1='treasurer' AND r.fee_centavos>0 AND r.status IN ('approved','ready','released'))
    ORDER BY CASE WHEN r.status IN ('released','rejected') THEN 1 ELSE 0 END, r.created_at DESC, r.id
    LIMIT 50 OFFSET $3`, [req.actor.role, req.actor.id, offset]);
  if (req.actor.role === 'treasurer') {
    for (const row of rows) {
      delete row.address;
      delete row.purpose;
      delete row.history;
      delete row.reason;
    }
  }
  res.json(rows);
});
api.post('/requests', mutate(async (req, client) => {
  role(req, 'staff', 'resident');
  const data = submission.parse(req.body);
  const { rows: [service] } = await client.query('SELECT fee_centavos FROM services WHERE id=$1 AND enabled', [data.service]);
  if (!service) throw new HttpError(409, 'This service is currently unavailable.');
  const { rows: [request] } = await client.query(`
    INSERT INTO requests (resident_id,service_id,applicant,address,purpose,fee_centavos)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,resident_id`, [
    req.actor.role === 'resident' ? req.actor.id : null, data.service,
    data.applicant, data.address, data.purpose, service.fee_centavos,
  ]);
  await recordStatus(client, req, request, 'submitted', null);
  if (!request.resident_id) await addQueue(req, client, request.id, 'filing');
  return { id: request.id };
}));

api.post('/requests/:id/actions/:action', mutate(async (req, client) => {
  role(req, 'staff', 'resident', 'approver');
  const request = await requestForUpdate(req, client);
  const action = req.params.action;
  const status = transition(action, request.status, req.actor.role);
  const reason = ['correct', 'reject', 'reject-ineligible'].includes(action) ? text(600).parse(req.body?.reason) : null;
  if (action === 'forward' && req.body?.verified !== true) throw new HttpError(400, 'Confirm eligibility verification.');
  if (status === 'released') {
    if (request.fee_centavos && !(await client.query('SELECT 1 FROM payments WHERE request_id=$1', [request.id])).rowCount) {
      throw new HttpError(409, 'The treasurer must record payment before release.');
    }
    const { rows: resolvedBookings } = await client.query(
      "UPDATE bookings SET state=CASE WHEN state='checked_in' THEN 'completed' ELSE 'cancelled' END " +
      "WHERE request_id=$1 AND state IN ('booked','checked_in') RETURNING id,state", [request.id],
    );
    for (const booking of resolvedBookings) {
      await audit(client, req.actor.id, 'appointment_' + booking.state, 'booking', booking.id);
    }
    await client.query("UPDATE queue SET state='completed' WHERE request_id=$1 AND kind='pickup' AND state IN ('waiting','serving')", [request.id]);
  }
  if (action === 'resubmit-assisted' && request.resident_id) throw new HttpError(403, 'The resident must resubmit this application.');
  if (action.startsWith('resubmit')) {
    const data = application.parse(req.body);
    await client.query('UPDATE requests SET applicant=$2,address=$3,purpose=$4 WHERE id=$1',
      [request.id, data.applicant, data.address, data.purpose]);
  }
  await client.query(`
    UPDATE requests SET status=$2, reason=$3, released_at=CASE WHEN $2='released' THEN now() END,
      released_by=CASE WHEN $2='released' THEN $4 END WHERE id=$1`, [request.id, status, reason, req.actor.id]);
  await recordStatus(client, req, request, status, reason);
}));

api.post('/requests/:id/payment', mutate(async (req, client) => {
  role(req, 'treasurer');
  const request = await requestForUpdate(req, client);
  const data = z.object({ centavos: amount, reference: text(80) }).parse(req.body);
  if (!request.fee_centavos || request.fee_centavos !== data.centavos || !['approved','ready'].includes(request.status)) {
    throw new HttpError(409, 'Payment must match the applicable fee on an approved request.');
  }
  await client.query('INSERT INTO payments (request_id,centavos,reference,recorded_by) VALUES ($1,$2,$3,$4)',
    [request.id, data.centavos, data.reference, req.actor.id]);
  await audit(client, req.actor.id, 'payment_recorded', 'request', request.id);
  await notify(client, request, 'Payment recorded');
}));

api.get('/slots', async (req, res) => {
  role(req, 'resident', 'staff');
  res.json((await db.query(`
    SELECT s.id, s.starts_at, s.capacity, (s.capacity - count(b.id))::int AS available
    FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id AND b.state IN ('booked','checked_in','completed','no_show')
    WHERE s.starts_at > now() GROUP BY s.id HAVING $1 OR s.capacity > count(b.id)
    ORDER BY s.starts_at LIMIT 200`, [req.actor.role === 'staff'])).rows);
});
api.post('/slots', mutate(async (req, client) => {
  role(req, 'staff');
  const { startsAt, capacity } = z.object({ startsAt: z.iso.datetime({ offset: true }), capacity: z.number().int().min(1).max(100) }).parse(req.body);
  if (Date.parse(startsAt) <= Date.now()) throw new HttpError(400, 'Choose a future time.');
  const { rows: [{ id }] } = await client.query('INSERT INTO slots (starts_at,capacity) VALUES ($1,$2) RETURNING id', [startsAt, capacity]);
  await audit(client, req.actor.id, 'slot_published', 'slot', id);
  return { id };
}));
api.put('/requests/:id/booking', mutate(async (req, client) => {
  role(req, 'resident');
  const request = await requestForUpdate(req, client);
  const slotId = uuid.parse(req.body?.slotId);
  if (request.status !== 'ready') throw new HttpError(409, 'This document is not ready for pickup.');
  const queued = await client.query("SELECT 1 FROM queue WHERE request_id=$1 AND state IN ('waiting','serving')", [request.id]);
  if (queued.rowCount) throw new HttpError(409, 'This request is already in the counter queue.');
  const { rows: [current] } = await client.query("SELECT * FROM bookings WHERE request_id=$1 AND state IN ('booked','checked_in')", [request.id]);
  if (current?.state === 'checked_in') throw new HttpError(409, 'You have already checked in.');
  if (current?.slot_id === slotId) return { id: current.id };
  const { rows: [slot] } = await client.query('SELECT capacity FROM slots WHERE id=$1 AND starts_at > now() FOR UPDATE', [slotId]);
  if (!slot) throw new HttpError(409, 'Choose an upcoming pickup slot.');
  const { rows: [{ count }] } = await client.query("SELECT count(*)::int FROM bookings WHERE slot_id=$1 AND state<>'cancelled'", [slotId]);
  if (count >= slot.capacity) throw new HttpError(409, 'That slot is full.');
  if (current) await client.query("UPDATE bookings SET state='cancelled' WHERE id=$1", [current.id]);
  const { rows: [{ id }] } = await client.query('INSERT INTO bookings (request_id,slot_id) VALUES ($1,$2) RETURNING id', [request.id, slotId]);
  await audit(client, req.actor.id, current ? 'pickup_rescheduled' : 'pickup_booked', 'booking', id);
  await notify(client, request, current ? 'Pickup rescheduled' : 'Pickup booked');
  return { id };
}));
api.delete('/requests/:id/booking', mutate(async (req, client) => {
  role(req, 'resident');
  const request = await requestForUpdate(req, client);
  const { rows: [booking] } = await client.query(`
    UPDATE bookings b SET state='cancelled' FROM slots s
    WHERE b.request_id=$1 AND b.state='booked' AND b.slot_id=s.id AND s.starts_at > now() RETURNING b.id`, [request.id]);
  if (!booking) throw new HttpError(409, 'No upcoming booking can be canceled.');
  await audit(client, req.actor.id, 'pickup_cancelled', 'booking', booking.id);
  await notify(client, request, 'Pickup canceled');
}));

async function addQueue(req, client, requestId, kind, bookingId = null) {
  const { rows: [entry] } = await client.query(`
    WITH ticket AS (
      INSERT INTO queue_counter VALUES (${today}, 1)
      ON CONFLICT (day) DO UPDATE SET last_number = queue_counter.last_number + 1 RETURNING *
    ) INSERT INTO queue (day,number,request_id,kind,booking_id)
    SELECT day,last_number,$1,$2,$3 FROM ticket RETURNING id,number`, [requestId, kind, bookingId]);
  await audit(client, req.actor.id, 'queue_joined', 'queue', entry.id);
  return entry;
}

api.get('/counter', async (req, res) => {
  role(req, 'staff');
  const [queue, bookings] = await Promise.all([
    db.query(`SELECT q.*, r.applicant FROM queue q JOIN requests r ON r.id=q.request_id
      WHERE q.day=${today} ORDER BY q.number`),
    db.query(`SELECT b.id,b.state,s.starts_at,r.id AS request_id,r.applicant,
      (s.starts_at AT TIME ZONE 'Asia/Manila')::date=${today} AS is_today
      FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN requests r ON r.id=b.request_id
      WHERE (s.starts_at AT TIME ZONE 'Asia/Manila')::date=${today} OR (s.starts_at<now() AND b.state='booked')
      ORDER BY s.starts_at LIMIT 500`),
  ]);
  res.json({ queue: queue.rows, bookings: bookings.rows });
});
api.post('/requests/:id/walk-in-pickup', mutate(async (req, client) => {
  role(req, 'staff');
  const request = await requestForUpdate(req, client);
  if (request.status !== 'ready') throw new HttpError(409, 'This document is not ready for pickup.');
  const active = await client.query("SELECT 1 FROM bookings WHERE request_id=$1 AND state IN ('booked','checked_in')", [request.id]);
  if (active.rowCount) throw new HttpError(409, 'Use the appointment check-in or resolve the existing booking first.');
  return addQueue(req, client, request.id, 'pickup');
}));
api.post('/requests/:id/appointment/:action', mutate(async (req, client) => {
  role(req, 'staff');
  const request = await requestForUpdate(req, client);
  const action = z.enum(['check-in','no-show','cancel']).parse(req.params.action);
  const bookingId = uuid.parse(req.body?.bookingId);
  const { rows: [booking] } = await client.query(`
    SELECT b.id, (s.starts_at AT TIME ZONE 'Asia/Manila')::date=${today} AS is_today, s.starts_at<=now() AS elapsed
    FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.id=$1 AND b.request_id=$2 AND b.state='booked'`,
  [bookingId, request.id]);
  if (!booking || (action === 'check-in' && (!booking.is_today || request.status !== 'ready')) ||
      (action === 'no-show' && !booking.elapsed)) throw new HttpError(409, 'This appointment cannot be updated.');
  const state = { 'check-in': 'checked_in', 'no-show': 'no_show', cancel: 'cancelled' }[action];
  await client.query('UPDATE bookings SET state=$2 WHERE id=$1', [booking.id, state]);
  await audit(client, req.actor.id, 'appointment_' + state, 'booking', booking.id);
  await notify(client, request, { checked_in: 'Pickup checked in', no_show: 'Pickup marked as missed', cancelled: 'Pickup canceled by staff' }[state]);
  if (action === 'check-in') return addQueue(req, client, request.id, 'pickup', booking.id);
}));
api.post('/queue/:id/:state', mutate(async (req, client) => {
  role(req, 'staff');
  const id = uuid.parse(req.params.id);
  const state = z.enum(['serving','completed','no_show']).parse(req.params.state);
  const { rows: [entry] } = await client.query('SELECT request_id FROM queue WHERE id=$1', [id]);
  if (!entry) throw new HttpError(404, 'Queue entry not found.');
  await client.query('SELECT id FROM requests WHERE id=$1 FOR UPDATE', [entry.request_id]);
  const from = state === 'serving' ? ['waiting'] : state === 'completed' ? ['serving'] : ['waiting','serving'];
  const { rows: [updated] } = await client.query(`
    UPDATE queue SET state=$2 WHERE id=$1 AND state=ANY($3::text[]) AND ($2<>'completed' OR kind='filing')
    RETURNING booking_id`, [id, state, from]);
  if (!updated) throw new HttpError(409, 'This queue transition is unavailable. Complete pickup by recording release.');
  if (state === 'no_show' && updated.booking_id) {
    await client.query("UPDATE bookings SET state='no_show' WHERE id=$1", [updated.booking_id]);
    const { rows: [request] } = await client.query('SELECT id,resident_id FROM requests WHERE id=$1', [entry.request_id]);
    await notify(client, request, 'Pickup marked as missed');
  }
  await audit(client, req.actor.id, 'queue_' + state, 'queue', id);
}));

api.get('/notifications', async (req, res) => {
  role(req, 'resident');
  res.json((await db.query('SELECT id, request_id, message, created_at, read_at FROM notifications WHERE resident_id=$1 ORDER BY id DESC LIMIT 100',
    [req.actor.id])).rows);
});
api.post('/notifications/:id/read', mutate(async (req, client) => {
  role(req, 'resident');
  const id = z.string().regex(/^\d{1,18}$/).parse(req.params.id);
  await client.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND resident_id=$2', [id, req.actor.id]);
}));
api.get('/dashboard', async (req, res) => {
  role(req, ...adminRoles, 'staff');
  res.json(await dashboardCounts(db));
});

api.get('/reports/yearly', async (req, res) => {
  role(req, ...adminRoles);
  const currentYear = Number(new Intl.DateTimeFormat('en-PH', { year: 'numeric', timeZone: 'Asia/Manila' }).format());
  const year = z.coerce.number().int().min(1900).max(9998).parse(req.query.year ?? currentYear);
  res.json(await yearlyActivity(db, year));
});

api.post('/residents', mutate(async (req, client) => {
  role(req, 'staff');
  const [resident] = await insertResidents(client, [validateResident(req.body)], 'walk_in');
  if (!resident) throw new HttpError(409, 'A resident with that name and contact number is already registered.');
  await audit(client, req.actor.id, 'resident_registered', 'resident', resident.id);
  return { id: resident.id };
}));

api.post('/residents/import', (req, res, next) => {
  role(req, ...adminRoles);
  next();
}, express.raw({ type: 'text/csv', limit: residentCsvLimit }), async (req, res) => {
  const mode = z.enum(['preview', 'commit']).parse(req.query.mode);
  const { rows, errors, duplicateRows } = parseResidentCsv(req.body);
  if (mode === 'preview') {
    const existingRows = await previewResidents(db, rows);
    duplicateRows.push(...existingRows);
    return res.json({
      ready: rows.length - existingRows.length,
      errors, duplicateRows: duplicateRows.sort((a, b) => a - b),
    });
  }
  if (errors.length) return res.status(400).json({ error: 'Correct the invalid CSV rows and preview the file again.', errors });
  return mutate(async (req, client) => {
    const inserted = await insertResidents(client, rows, 'csv');
    const keys = new Set(inserted.map(record => JSON.stringify([record.name_key, record.contact_key])));
    duplicateRows.push(...rows.filter(row => !keys.has(JSON.stringify([row.nameKey, row.contactKey]))).map(row => row.row));
    await audit(client, req.actor.id, 'resident_csv_import', 'resident_register', 'batch', inserted.length ? 'success' : 'no_changes');
    return { inserted: inserted.length, duplicateRows: duplicateRows.sort((a, b) => a - b) };
  })(req, res);
});

api.get('/reports', async (req, res) => {
  role(req, ...employeeRoles);
  const { from, to } = z.object({ from: z.iso.date(), to: z.iso.date() }).parse(req.query);
  if (from > to) throw new HttpError(400, 'The start date must precede the end date.');
  res.json((await db.query(`
    SELECT s.name AS service,r.status,count(*)::int AS total FROM requests r JOIN services s ON s.id=r.service_id
    WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Manila')
      AND created_at < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Manila')
    GROUP BY s.name,r.status ORDER BY s.name,r.status`, [from, to])).rows);
});
api.get('/employees', async (req, res) => {
  role(req, ...adminRoles);
  res.json((await db.query('SELECT email, role, enabled FROM employee ORDER BY email')).rows);
});
api.put('/employees', mutate(async (req, client) => {
  role(req, ...adminRoles);
  const data = z.object({ email: z.email().transform(v => v.toLowerCase()), role: z.enum(employeeRoles), enabled: z.boolean() }).parse(req.body);
  if (data.email === req.actor.email) throw new HttpError(409, 'Another administrator must manage your access.');
  // Lock in the same order as the authenticated mutation check.
  const { rows: [user] } = await client.query('SELECT id FROM "user" WHERE email=$1 FOR UPDATE', [data.email]);
  await client.query(`INSERT INTO employee (email, role, enabled) VALUES ($1,$2,$3)
    ON CONFLICT (email) DO UPDATE SET role=excluded.role,enabled=excluded.enabled`, [data.email, data.role, data.enabled]);
  if (user) await client.query('DELETE FROM session WHERE "userId"=$1', [user.id]);
  await audit(client, req.actor.id, 'employee_access_configured', 'employee', user?.id || 'pending-enrollment');
}));
api.get('/audit', async (req, res) => {
  role(req, ...adminRoles);
  res.json((await db.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100')).rows);
});
