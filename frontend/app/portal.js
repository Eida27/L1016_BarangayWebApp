'use client';

import { useCallback, useEffect, useState } from 'react';

const labels = {
  resident: 'Resident', staff: 'Barangay staff', approver: 'Barangay captain',
  treasurer: 'Treasurer', admin: 'Administrator', submitted: 'Submitted',
  under_review: 'Under review', awaiting_approval: 'Awaiting approval',
  needs_correction: 'Needs correction', approved: 'Approved', ready: 'Ready for pickup',
  rejected: 'Rejected', released: 'Released', checked_in: 'Checked in', no_show: 'No-show',
};
const label = value => labels[value] || value.replaceAll('_', ' ');
const time = value => new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));
const money = cents => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(cents / 100);
const manilaDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const requestPath = id => '/requests/' + id;

async function api(path, method = 'GET', body) {
  const csv = body instanceof File;
  const response = await fetch('/api/v1' + path, {
    method, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': csv ? 'text/csv' : 'application/json' }, body: csv ? body : JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || result.message || 'Unable to complete the request.'), { status: response.status });
  return result;
}

function Form({ children, submit, onSubmit, className }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className={className} onSubmit={async event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try { await onSubmit(fields); } catch (error) { setError(error.message); } finally { setBusy(false); }
  }}>
    <fieldset disabled={busy}>{children}<button type="submit">{busy ? 'Working…' : submit}</button></fieldset>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function Field({ title, ...props }) {
  return <label>{title}<input required {...props} /></label>;
}

function Credentials({ refresh }) {
  const [mode, setMode] = useState('sign-in');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('token') && params.get('mode') === 'reset') setMode('reset');
    else if (params.has('error')) setMessage('That link could not be used. Request a new link or sign in to resend verification.');
  }, []);
  const titles = { 'sign-in': 'Sign in', register: 'Create an account', forgot: 'Recover your account', reset: 'Set a new password', mfa: 'Enter authenticator code', backup: 'Enter a backup code' };
  const verification = mode === 'mfa' || mode === 'backup';
  return <section className="card auth-card">
    <h2>{titles[mode]}</h2>
    <Form key={mode} submit={titles[mode]} onSubmit={async fields => {
      setMessage('');
      if (mode === 'register') {
        await api('/auth/sign-up/email', 'POST', { ...fields, callbackURL: '/' });
        setMessage('Check your email for a verification link, then sign in.');
        setMode('sign-in');
      } else if (mode === 'forgot') {
        await api('/auth/request-password-reset', 'POST', { ...fields, redirectTo: '/?mode=reset' });
        setMessage('If this address has an account, check your email for recovery instructions.');
      } else if (mode === 'reset') {
        await api('/auth/reset-password', 'POST', { newPassword: fields.password, token: new URLSearchParams(window.location.search).get('token') });
        window.history.replaceState(null, '', '/');
        setMode('sign-in');
        setMessage('Password updated. Sign in to continue.');
      } else if (verification) {
        await api('/auth/two-factor/' + (mode === 'backup' ? 'verify-backup-code' : 'verify-totp'), 'POST', fields);
        await refresh();
      } else {
        const result = await api('/auth/sign-in/email', 'POST', { ...fields, callbackURL: '/', rememberMe: false });
        if (result.twoFactorRedirect) setMode('mfa');
        else await refresh();
      }
    }}>
      {mode === 'register' && <Field title="Full name" name="name" maxLength={120} autoComplete="name" />}
      {!verification && mode !== 'reset' && <Field title="Email address" name="email" type="email" autoComplete="email" />}
      {!verification && mode !== 'forgot' && <Field title="Password" name="password" type="password" minLength={mode === 'sign-in' ? undefined : 12} maxLength={128} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} />}
      {verification && <Field title={mode === 'backup' ? 'Backup code' : 'Six-digit code'} name="code" autoComplete="one-time-code" inputMode={mode === 'mfa' ? 'numeric' : 'text'} />}
    </Form>
    {message && <p role="status">{message}</p>}
    <div className="links">
      {mode !== 'sign-in' && <button className="link" onClick={() => setMode('sign-in')}>Back to sign in</button>}
      {mode === 'sign-in' && <><button className="link" onClick={() => setMode('register')}>Register</button><button className="link" onClick={() => setMode('forgot')}>Forgot password?</button></>}
      {verification && <button className="link" onClick={() => setMode(mode === 'mfa' ? 'backup' : 'mfa')}>{mode === 'mfa' ? 'Use a backup code' : 'Use an authenticator code'}</button>}
    </div>
  </section>;
}

function Enrollment({ refresh }) {
  const [enrollment, setEnrollment] = useState(null);
  return <section className="card">
    <h2>Set up employee two-factor authentication</h2>
    <p>Use an authenticator app. Store the backup codes somewhere secure before continuing.</p>
    {enrollment ? <>
      {/* The QR data stays in the browser. */}
      <img src={enrollment.qr} alt="Scan this code with your authenticator app" width={200} height={200} />
      <details><summary>Enter the setup key manually</summary><code>{new URL(enrollment.totpURI).searchParams.get('secret')}</code></details>
      <details><summary>Show backup codes</summary><pre>{enrollment.backupCodes.join('\n')}</pre></details>
      <Form submit="Verify and continue" onSubmit={async fields => {
        await api('/auth/two-factor/verify-totp', 'POST', fields);
        await api('/auth/sign-out', 'POST', {});
        await refresh();
      }}><Field title="Authenticator code" name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" /></Form>
    </> : <Form submit="Generate setup code" onSubmit={async fields => {
      const data = await api('/auth/two-factor/enable', 'POST', fields);
      const { default: qr } = await import('qrcode');
      setEnrollment({ ...data, qr: await qr.toDataURL(data.totpURI) });
    }}><Field title="Current password" name="password" type="password" autoComplete="current-password" /></Form>}
  </section>;
}

function ApplicationFields({ request }) {
  return <>
    <Field title="Applicant name" name="applicant" defaultValue={request?.applicant} maxLength={120} />
    <Field title="Barangay address" name="address" defaultValue={request?.address} maxLength={300} />
    <Field title="Purpose" name="purpose" defaultValue={request?.purpose} maxLength={300} />
  </>;
}

function Filing({ staff, services, run }) {
  return <section className="card">
    <h2>{staff ? 'File a walk-in application' : 'Request a document'}</h2>
    {services.length ? <>
      <details><summary>Service requirements and fees</summary>
        {services.map(service => <div key={service.id}><strong>{service.name} · {money(service.fee_centavos)}</strong><p>{service.instructions}</p></div>)}
      </details>
      <Form submit="Submit request" onSubmit={fields => run('/requests', 'POST', fields, 'Request submitted.')}>
        <label>Document<select name="service" required>{services.map(service => <option value={service.id} key={service.id}>{service.name}</option>)}</select></label>
        <ApplicationFields />
      </Form>
    </> : <p>Online filing opens once the barangay publishes its service requirements.</p>}
  </section>;
}

const decisionActions = [['approve', 'Approve'], ['reject', 'Reject']];
const staffActions = {
  awaiting_approval: decisionActions,
  submitted: [['review', 'Begin review']],
  under_review: [['forward', 'Send for approval'], ['correct', 'Request correction'], ['reject-ineligible', 'Reject as ineligible']],
  approved: [['ready', 'Mark signed document ready']],
  ready: [['release', 'Record physical release']],
};

function RequestCard({ request: r, role, slots, run }) {
  const path = requestPath(r.id);
  const staff = role === 'staff';
  const actions = staff ? staffActions[r.status] || [] : role === 'approver' && r.status === 'awaiting_approval' ? decisionActions : [];
  return <details className="record">
    <summary><span><strong>{r.service}</strong><small>{r.applicant} · {time(r.created_at)}</small></span><span className="badge">{label(r.status)}</span></summary>
    <div className="record-body">
      <p className="muted">Reference <code>{r.id}</code></p>
      {r.address && <p><strong>Address</strong> {r.address}<br /><strong>Purpose</strong> {r.purpose}</p>}
      {r.reason && <p><strong>Reason</strong> {r.reason}</p>}
      <p>Fee {money(r.fee_centavos)}{r.paid ? ' · Paid' : ''}{r.payment_reference ? ' · Receipt ' + r.payment_reference : ''}</p>
      {r.starts_at && <p>Pickup {time(r.starts_at)} · {label(r.booking_state)}</p>}
      {r.history?.length > 0 && <details><summary>Request history</summary>
        <ol>{r.history.map((entry, index) => <li key={index}>{label(entry.status)} · {time(entry.at)}{entry.reason && ' · ' + entry.reason}</li>)}</ol>
      </details>}
      {actions.map(([action, name]) => <Form key={action} submit={name} onSubmit={fields => run(path + '/actions/' + action, 'POST', {
        ...fields, verified: fields.verified === 'on',
      })}>
        {action === 'forward' && <label className="check"><input type="checkbox" name="verified" required /> I verified the applicant’s eligibility and supporting evidence.</label>}
        {action === 'release' && <label className="check"><input type="checkbox" required /> The signed paper document has been handed to the recipient.</label>}
        {['correct', 'reject', 'reject-ineligible'].includes(action) && <Field title="Reason visible to resident" name="reason" maxLength={600} />}
      </Form>)}
      {r.status === 'needs_correction' && (role === 'resident' || (staff && r.assisted)) &&
        <Form submit="Resubmit corrected request" onSubmit={fields => run(path + '/actions/' + (staff ? 'resubmit-assisted' : 'resubmit'), 'POST', fields)}>
          <ApplicationFields request={r} />
        </Form>}
      {role === 'treasurer' && !r.paid && r.status !== 'released' &&
        <Form submit={'Record ' + money(r.fee_centavos) + ' payment'} onSubmit={fields => run(path + '/payment', 'POST', { ...fields, centavos: r.fee_centavos })}>
          <Field title="Official receipt reference" name="reference" maxLength={80} />
        </Form>}
      {staff && r.status === 'ready' && !r.booking_state &&
        <Form submit="Queue walk-in pickup" onSubmit={() => run(path + '/walk-in-pickup', 'POST', {})} />}
      {role === 'resident' && r.status === 'ready' && r.booking_state !== 'checked_in' && <>
        {slots.length ? <Form submit={r.booking_state ? 'Reschedule pickup' : 'Book pickup'} onSubmit={fields => run(path + '/booking', 'PUT', fields)}>
          <label>Pickup time (Manila)<select name="slotId" required>
            {slots.map(slot => <option key={slot.id} value={slot.id}>{time(slot.starts_at)} · {slot.available} available</option>)}
          </select></label>
        </Form> : <p>No pickup times available. Check again later or contact the barangay.</p>}
        {r.booking_state === 'booked' && Date.parse(r.starts_at) > Date.now() &&
          <Form submit="Cancel booking" onSubmit={() => run(path + '/booking', 'DELETE')} />}
      </>}
    </div>
  </details>;
}

function Counter({ counter, slots, run }) {
  return <>
    <section className="card">
      <h2>Pickup slots</h2>
      <Form submit="Publish slot" onSubmit={fields => run('/slots', 'POST', {
        startsAt: fields.startsAt + ':00+08:00', capacity: Number(fields.capacity),
      })}>
        <Field title="Start time (Manila)" name="startsAt" type="datetime-local" />
        <Field title="Capacity" name="capacity" type="number" min={1} max={100} defaultValue={1} />
      </Form>
      <ul>{slots.map(slot => <li key={slot.id}>{time(slot.starts_at)} · {slot.available}/{slot.capacity} available</li>)}</ul>
    </section>
    <section className="card">
      <h2>Counter queue</h2>
      <a href="/queue" target="_blank" rel="noreferrer">Open queue display</a>
      {!counter.queue.length && <p>No tickets today.</p>}
      {counter.queue.map(q => <div className="record-body" key={q.id}>
        <strong>#{q.number} · {q.applicant}</strong><p>{label(q.kind)} · {label(q.state)}</p>
        <div className="links">
          {(q.state === 'waiting' ? ['serving', 'no_show'] : q.state === 'serving' ? [...(q.kind === 'filing' ? ['completed'] : []), 'no_show'] : [])
            .map(state => <Form key={state} submit={label(state)} onSubmit={() => run('/queue/' + q.id + '/' + state, 'POST', {})} />)}
        </div>
      </div>)}
    </section>
    <section className="card">
      <h2>Today’s appointments and unresolved visits</h2>
      {!counter.bookings.length && <p>No appointments to display.</p>}
      {counter.bookings.map(b => <div className="record-body" key={b.id}>
        <strong>{b.applicant}</strong><p>{time(b.starts_at)} · {label(b.state)}</p>
        {b.state === 'booked' && <div className="links">
          {[...(b.is_today ? [['check-in', 'Check in']] : []), ...(Date.parse(b.starts_at) <= Date.now() ? [['no-show', 'Mark missed']] : []), ['cancel', 'Cancel']]
            .map(([action, title]) => <Form key={action} submit={title} onSubmit={() =>
              run(requestPath(b.request_id) + '/appointment/' + action, 'POST', { bookingId: b.id })} />)}
        </div>}
      </div>)}
    </section>
  </>;
}

function Reports() {
  const [data, setData] = useState(null);
  return <section className="card"><h2>Request totals</h2>
    <Form submit="Run report" onSubmit={async fields => setData(await api('/reports?' + new URLSearchParams(fields)))}>
      <Field title="From (Manila)" name="from" type="date" defaultValue={manilaDate()} />
      <Field title="Through (Manila)" name="to" type="date" defaultValue={manilaDate()} />
    </Form>
    {data && (data.length ? <table><thead><tr><th>Service</th><th>Status</th><th>Total</th></tr></thead>
      <tbody>{data.map(row => <tr key={row.service + row.status}><td>{row.service}</td><td>{label(row.status)}</td><td>{row.total}</td></tr>)}</tbody>
    </table> : <p>No requests in this period.</p>)}
  </section>;
}

function Admin({ services, employees, audit, run }) {
  return <>
    <section className="card"><h2>Service catalog</h2>
      {services.map(service => <details className="record" key={service.id}>
        <summary>{service.name} · {service.enabled ? 'Published' : 'Disabled'}</summary>
        <Form className="record-body" submit="Save service" onSubmit={fields => run('/services/' + service.id, 'PUT', {
          instructions: fields.instructions, fee: Math.round(Number(fields.fee) * 100), enabled: fields.enabled === 'on',
        })}>
          <label>Approved requirements and verification instructions
            <textarea name="instructions" required maxLength={1500} defaultValue={service.instructions} />
          </label>
          <Field title="Fee in pesos" name="fee" type="number" min={0} max={100000} step="0.01" defaultValue={service.fee_centavos / 100} />
          <label className="check"><input name="enabled" type="checkbox" defaultChecked={service.enabled} /> Publish for filing</label>
        </Form>
      </details>)}
    </section>
    <section className="card"><h2>Employee access</h2>
      <p>Reserve an approved email address, then have the employee register, verify the address, and enroll their authenticator.</p>
      <Form submit="Save employee access" onSubmit={fields => run('/employees', 'PUT', { ...fields, enabled: fields.enabled === 'on' })}>
        <Field title="Approved employee email" type="email" name="email" />
        <label>Role<select name="role">{['staff', 'approver', 'treasurer', 'admin'].map(role => <option key={role} value={role}>{label(role)}</option>)}</select></label>
        <label className="check"><input type="checkbox" name="enabled" defaultChecked /> Account enabled</label>
      </Form>
      <ul>{employees.map(e => <li key={e.email}>{e.email} · {label(e.role)} · {e.enabled ? 'Enabled' : 'Disabled'}</li>)}</ul>
    </section>
    <section className="card"><h2>Recent audit events</h2>
      <ul>{audit.map(event => <li key={event.id}>{time(event.created_at)} · {label(event.action)} · {event.outcome} <small>{event.entity} {event.target_id} · Actor {event.actor_id || 'unidentified'}</small></li>)}</ul>
    </section>
  </>;
}

const csvTemplate = 'data:text/csv;charset=utf-8,name%2Ccontact_number%2Cage%2Csex%0D%0A';

function ResidentRegistration({ run }) {
  const [version, setVersion] = useState(0);
  return <section className="card">
    <h2>Register a resident</h2>
    <Form key={version} submit="Register resident" onSubmit={async fields => {
      await run('/residents', 'POST', fields, 'Resident registered.');
      setVersion(value => value + 1);
    }}>
      <Field title="Full name" name="name" maxLength={120} />
      <Field title="Contact number" name="contactNumber" type="tel" maxLength={40} />
      <Field title="Age" name="age" type="number" min={0} max={130} />
      <label>Sex<select name="sex" required defaultValue="">
        <option value="" disabled>Select sex</option>
        <option value="female">Female</option><option value="male">Male</option>
        <option value="other">Other</option><option value="undisclosed">Undisclosed</option>
      </select></label>
    </Form>
  </section>;
}

function ResidentImport() {
  const [preview, setPreview] = useState(null);
  const [receipt, setReceipt] = useState(null);
  return <div className="stack">
    <section className="card">
      <h2>Upload a CSV file</h2>
      <p><a href={csvTemplate} download="resident-import.csv">Download the CSV template</a></p>
      <p className="muted">UTF-8 CSV, up to 5,000 residents and 2 MiB. Keep contact numbers formatted as text.</p>
      <Form submit="Preview CSV" onSubmit={async ({ file }) => {
        setPreview(null);
        setReceipt(null);
        if (!file?.size) throw new Error('Choose a CSV file.');
        if (file.size > 2 * 1024 * 1024) throw new Error('The CSV exceeds 2 MiB.');
        setPreview({ file, ...await api('/residents/import?mode=preview', 'POST', file) });
      }}>
        <label>Resident CSV<input name="file" type="file" accept=".csv,text/csv" required onChange={() => {
          setPreview(null);
          setReceipt(null);
        }} /></label>
      </Form>
    </section>
    {preview && <section className="card">
      <h2>Import preview</h2>
      <p>{preview.file.name}</p>
      <p>{preview.ready} ready · {preview.duplicateRows.length} duplicates · {preview.errors.length} invalid</p>
      {preview.errors.length > 0 && <details open>
        <summary>Rows to correct</summary>
        <ul className="import-rows">{preview.errors.map(({ row, message }) => <li key={row}>Row {row} · {message}</li>)}</ul>
      </details>}
      {preview.duplicateRows.length > 0 && <details>
        <summary>Duplicate rows to skip</summary><p className="import-rows">{preview.duplicateRows.join(', ')}</p>
      </details>}
      {!preview.errors.length && preview.ready > 0 && <Form submit="Confirm import" onSubmit={async () => {
        setReceipt(await api('/residents/import?mode=commit', 'POST', preview.file));
        setPreview(null);
      }} />}
    </section>}
    {receipt && <p className="notice" role="status">{receipt.inserted} residents imported. {receipt.duplicateRows.length} duplicate rows skipped.</p>}
  </div>;
}

function Summary({ counts }) {
  const metrics = [
    ['Registered residents', counts.residents],
    ['Pending document requests', counts.pending],
    ['Resolved document requests', counts.resolved],
  ];
  return <section className="metrics" aria-label="Barangay totals">
    {metrics.map(([title, value]) => <article key={title} className="card metric">
      <h2>{title}</h2><p>{value.toLocaleString('en-PH')}</p>
      {title === 'Resolved document requests' && <small>{counts.released} released · {counts.rejected} rejected</small>}
    </article>)}
  </section>;
}

const monthNames = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat('en-PH', {
  month: 'short', timeZone: 'UTC',
}).format(new Date(Date.UTC(2000, index, 1))));

function ActivityTable({ title, columns, months, totals }) {
  return <section className="card">
    <h2>{title}</h2>
    <table aria-label={title}>
      <thead><tr><th scope="col">Month</th>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{months.map((values, index) => <tr key={index}><th scope="row">{monthNames[index]}</th>
        {values.map((value, col) => <td key={col}>{value}</td>)}</tr>)}</tbody>
      <tfoot><tr><th scope="row">Total</th>{totals.map((value, col) => <td key={col}>{value}</td>)}</tr></tfoot>
    </table>
  </section>;
}

function YearlyReport({ data, setYear }) {
  const requestColumns = ['Received', 'Released', 'Rejected'];
  const requestValues = ({ received, released, rejected }) => [received, released, rejected];
  const registrationValues = ({ walkIn, csv }) => [walkIn, csv];
  return <div className="stack">
    <section className="card">
      <Form submit="View year" onSubmit={({ year }) => setYear(year)}>
        <Field title="Calendar year (Manila)" name="year" type="number" defaultValue={data.year} min={1900} max={9998} />
      </Form>
    </section>
    <h2 className="report-year">{data.year} service activity</h2>
    <div className="report-tables">
      {data.services.map(({ id, name }, index) => <ActivityTable key={id} title={name} columns={requestColumns}
        months={data.months.map(month => requestValues(month.services[index]))} totals={requestValues(data.totals.services[index])} />)}
      <ActivityTable title="Resident registrations" columns={['Walk-in', 'CSV import']}
        months={data.months.map(month => registrationValues(month.registrations))} totals={registrationValues(data.totals.registrations)} />
    </div>
  </div>;
}

const employeeSections = {
  admin: ['Dashboard', 'Yearly Reports', 'Import Residents', 'Administration'],
  approver: ['Dashboard', 'Yearly Reports', 'Import Residents', 'Requests & Registration', 'Administration'],
  staff: ['Dashboard', 'Requests & Registration', 'Counter & Pickup'],
};

function Workspace({ account }) {
  const [section, setSection] = useState('Dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const sections = employeeSections[account.role];
  if (!sections) return <Dashboard account={account} />;
  return <div className="workspace">
    <aside className="workspace-sidebar">
      <button type="button" className="secondary workspace-toggle" aria-expanded={menuOpen} aria-controls="workspace-navigation"
        onClick={() => setMenuOpen(value => !value)}>{menuOpen ? 'Close menu' : 'Open menu'} <span>· {section}</span></button>
      <nav aria-label="Employee workspace" id="workspace-navigation" className={menuOpen ? 'workspace-navigation open' : 'workspace-navigation'}>
        {sections.map(item => <button type="button" key={item} aria-current={section === item ? 'page' : undefined}
          onClick={() => { setSection(item); setMenuOpen(false); }}>{item}</button>)}
      </nav>
    </aside>
    <Dashboard key={section} account={account} section={section} />
  </div>;
}

function Dashboard({ account, section }) {
  const { role } = account;
  const [year, setYear] = useState(() => manilaDate().slice(0, 4));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const refresh = useCallback(async () => {
    const paths = {
      Dashboard: ['dashboard'],
      'Yearly Reports': ['reports/yearly?year=' + year],
      Administration: ['services', 'employees', 'audit'],
      'Requests & Registration': role === 'staff' ? ['services', 'slots'] : [],
      'Counter & Pickup': ['slots', 'counter'],
    }[section] || (role === 'resident' ? ['services', 'slots', 'notifications'] : []);
    const needsRequests = !section || section === 'Requests & Registration';
    const pairs = await Promise.all([
      ...paths.map(async path => [path.split('?')[0], await api('/' + path)]),
      ...(needsRequests ? [api('/requests?offset=' + offset).then(requests => ['requests', requests])] : []),
    ]);
    setData(Object.fromEntries(pairs));
    setError('');
  }, [role, offset, section, year]);
  useEffect(() => { refresh().catch(error => setError(error.message)); }, [refresh]);
  async function run(path, method, fields, success = 'Saved.') {
    setMessage('');
    await api(path, method, fields);
    setMessage(success);
    try { await refresh(); } catch (error) { setError(error.message); }
  }
  return <div className="workspace-panel">
    <div className="heading"><p className="eyebrow">{label(role)} workspace</p><h1>{section || 'Welcome, ' + account.name}</h1>
      {section === 'Dashboard' && <p>Welcome, {account.name}</p>}
      {!section && <p>{role === 'resident' ? 'Manage your barangay document requests and pickup appointments.' : 'Manage barangay service work for your assigned role.'}</p>}
      {section !== 'Import Residents' && <button className="secondary" onClick={() => refresh().catch(error => setError(error.message))}>Refresh</button>}
    </div>
    {message && <p className="notice" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {section === 'Import Residents' && <ResidentImport />}
    {!data && !error && section !== 'Import Residents' && <p role="status">Loading…</p>}
    {data?.dashboard && <Summary counts={data.dashboard} />}
    {data?.['reports/yearly'] && <YearlyReport data={data['reports/yearly']} setYear={setYear} />}
    {data?.employees && <div className="stack"><Admin {...data} run={run} /></div>}
    {data?.counter && <div className="dashboard"><Counter counter={data.counter} slots={data.slots} run={run} /></div>}
    {data?.requests && <div className="dashboard">
      <div className="stack">
        <section className="card">
          <h2>{role === 'resident' ? 'Your requests' : 'Request worklist'}</h2>
          {!data.requests.length && <p>No requests on this page.</p>}
          {data.requests.map(r => <RequestCard key={r.id} request={r} role={role} slots={data.slots} run={run} />)}
          <div className="links">
            {offset > 0 && <button className="secondary" onClick={() => setOffset(offset - 50)}>Previous</button>}
            {data.requests.length === 50 && <button className="secondary" onClick={() => setOffset(offset + 50)}>Next</button>}
          </div>
        </section>
      </div>
      {(role !== 'approver') && <aside className="stack">
        {role === 'staff' && <ResidentRegistration run={run} />}
        {['resident','staff'].includes(role) && <Filing staff={role === 'staff'} services={data.services} run={run} />}
        {role === 'treasurer' && <Reports />}
        {role === 'resident' && <section className="card"><h2>Notifications</h2>
          {!data.notifications.length && <p>No notifications yet.</p>}
          {data.notifications.map(n => <div className="record-body" key={n.id}><strong>{n.message}</strong><small>{time(n.created_at)}</small>
            {!n.read_at && <Form submit="Mark read" onSubmit={() => run('/notifications/' + n.id + '/read', 'POST', {})} />}
          </div>)}
        </section>}
      </aside>}
    </div>}
  </div>;
}

export default function Portal() {
  const [account, setAccount] = useState(undefined);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setError('');
    try { setAccount(await api('/me')); } catch (error) {
      setAccount(null);
      if (error.status !== 401) setError(error.message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return <>
    <header><a href="/" className="brand"><span aria-hidden="true">BS</span> Barangay Services</a>
      {account && <Form submit="Sign out" onSubmit={async () => { await api('/auth/sign-out', 'POST', {}); await refresh(); }} />}
    </header>
    <main>
      {error && <p className="error" role="alert">{error}</p>}
      {account === undefined ? <p role="status">Checking your session…</p> : account ? (
        account.mfaRequired ? <Enrollment refresh={refresh} /> : <Workspace key={account.id} account={account} />
      ) : <div className="welcome">
        <div><p className="eyebrow">Resident portal and staff services</p>
          <h1>Barangay documents and appointments</h1>
          <p>Apply for barangay clearance or a certificate of residency, track your request, and schedule pickup when your document is ready.</p>
          <p className="muted">The barangay verifies eligibility during review. Collect signed documents in person.</p>
          <a href="/privacy">Privacy information</a>
        </div><Credentials refresh={refresh} />
      </div>}
    </main>
    <footer>Barangay Service Request and Appointment Management System</footer>
  </>;
}
