# Barangay Service Request and Appointment Management System

The resident portal handles barangay clearance and certificate of residency requests. Role-specific staff workspaces handle review, approval, fees, paper release, pickups, and walk-ins. The public queue display at /queue shows ticket numbers only.

## Repository layout

- `frontend/app/` contains the Next.js App Router pages and components, written in JavaScript.
- `backend/` contains the Express server, API routes, authentication, and PostgreSQL access.
- `migrations/` and `scripts/` contain the PostgreSQL schema migrations and project tooling.

Express serves both the API and the Next.js frontend on the same origin. Run the npm commands from the repository root.

## Local setup

1. Use Node 24, npm, PostgreSQL 18, and a local SMTP catcher such as Mailpit. Create a dedicated database owned by a migration login and a separate, non-owner runtime login. Keep PostgreSQL and SMTP on loopback or an isolated local network.
2. Run `npm ci`. Copy `.env.example` to `.env.local`, fill in the database URLs and mail settings, and generate the authentication secret with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. The local commands also accept `.env`. If both files exist, `.env.local` overrides values from `.env`, and exported environment variables take precedence. Node may report that an optional file is missing and continue.
3. Run `npm run db:migrate`. As the migration owner, run `psql -v ON_ERROR_STOP=1 -v runtime=barangay_runtime -f scripts/runtime-grants.sql` against the same database. Set `BOOTSTRAP_ADMIN_EMAIL` to your approved administrator address and run `npm run db:bootstrap` once.
4. Run `npm run dev` and open [localhost](http://localhost:3000). Register with the bootstrap address, verify the email through the SMTP catcher, sign in, and set up an authenticator. Keep backup codes in a secure location.
5. In the administrator workspace, configure and publish both services and reserve separate employee email addresses for staff, approver, and treasurer. Each employee registers, verifies their email, and enrolls MFA. Use another email for resident acceptance testing.

The service catalog starts disabled. Confirm the official requirements, fees, and authorization procedures before publishing it. A request keeps the fee configured when it was submitted. Assisted filing supports residents without an online account. Staff communicate updates to those residents using the existing counter process.

## Employee workspace

- **Admin and barangay captain** can view the dashboard and yearly reports, import resident CSV files, manage service settings and employee access, and inspect audit history. The captain uses the existing `approver` role and can also approve or reject reviewed requests.
- **Barangay staff** can view the dashboard, register walk-ins, review and decide eligible document requests, and manage the counter and pickup workflow. Staff confirm eligibility before a request enters Awaiting approval. A final rejection requires a reason.
- **Dashboard** counts official register entries, regardless of portal accounts. A request stays pending through review, approval, and pickup preparation. Released and rejected requests are resolved. Yearly reports use the Manila calendar and count registrations, submissions, releases, and rejections when they occurred.

### Import the resident register

Download the template from **Import Residents**. Save the file as UTF-8 CSV with the headers `name,contact_number,age,sex`. Keep contact numbers formatted as text to preserve leading zeros. Enter age in whole years from 0 to 130. Accepted sex values are `female`, `male`, `other`, and `undisclosed`. The CSV also accepts `F` and `M`.

Preview up to 5,000 data rows and 2 MiB, correct invalid rows, then confirm. The system skips repeated entries with the same normalized name and phone number. Matching ignores name case, repeated spaces, and phone punctuation, and treats Philippine mobile numbers starting with `+63` and `09` as equivalent. Existing entries are kept. Walk-in and CSV registrations count immediately after saving.

## Verification

- `npm test` checks workflow transitions and CSV validation.
- `npm run build` compiles the production frontend.
- `npm run test:integration` exercises HTTP routes against an **empty disposable database** with synthetic data. Set `TEST_DATABASE_URL` to the disposable database owner URL. The test migrates the database, starts a local SMTP catcher and Next/Express server, and leaves its test records for inspection. Use a new database for each run.

## Production handoff

Use the LGU-approved managed provider. Set a single canonical HTTPS origin. Place a trusted reverse proxy or load balancer in front of Express, restrict direct access, and set `TRUST_PROXY_HOPS` to the exact topology. Set `HOST=0.0.0.0` only when the private deployment network requires it. Set `PORT` to the platform port. Terminate TLS at the trusted ingress and use provider-approved private connectivity and TLS for PostgreSQL. Use a verified mail sender and provider-managed secrets.

Run migrations with the owner credential in a release job and apply the grants. Give the web service only the runtime credential. Run `npm run build` and then `npm start`. Check `/api/v1/health` from the load balancer. Monitor availability, API errors, denied sign-ins, SMTP failures, and backup health. Keep request bodies and verification URLs out of proxy and application logs. Configure ingress rate limits across replicas.

Before go-live, obtain privacy lead and operations sign-off on the Privacy Impact Assessment, the published privacy notice and contact details, approved retention and disposal rules, authorized staff, hosting and SMTP terms, and incident procedures. Replace the bundled generic privacy information with the approved barangay notice. Configure encrypted automated backups with LGU-approved recovery targets, restore to an isolated database, and verify audit, request, payment, and queue records. Rehearse the service workflow and paper continuity process with staff, using synthetic data in staging. Reconcile paper transactions after outages under staff supervision. For employee MFA recovery, use backup codes or an LGU-approved identity-verification and administrator recovery procedure before resetting enrollment.
