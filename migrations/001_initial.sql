CREATE TABLE "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
  "twoFactorEnabled" boolean DEFAULT false
);
CREATE TABLE session (
  id text PRIMARY KEY, token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE
);
CREATE TABLE account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
  "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE TABLE verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
);
CREATE TABLE "twoFactor" (
  id text PRIMARY KEY, secret text NOT NULL, "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE UNIQUE,
  verified boolean DEFAULT true
);
CREATE INDEX session_user_idx ON session ("userId");
CREATE INDEX account_user ON account ("userId");
CREATE INDEX verification_identifier ON verification (identifier);

CREATE TABLE employee (
  email text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin','staff','approver','treasurer')),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE services (
  id text PRIMARY KEY, name text NOT NULL, instructions text NOT NULL,
  fee_centavos integer NOT NULL CHECK (fee_centavos >= 0), enabled boolean NOT NULL DEFAULT true
);
INSERT INTO services VALUES
  ('clearance', 'Barangay clearance', 'Contact the barangay for requirements before filing.', 0, false),
  ('residency', 'Certificate of residency', 'Contact the barangay for requirements before filing.', 0, false);
CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resident_id text REFERENCES "user",
  service_id text NOT NULL REFERENCES services, applicant text NOT NULL, address text NOT NULL, purpose text NOT NULL,
  fee_centavos integer NOT NULL CHECK (fee_centavos >= 0),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN
    ('submitted','under_review','needs_correction','awaiting_approval','approved','ready','released','rejected')),
  reason text, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  released_by text REFERENCES "user"
);
CREATE INDEX requests_resident ON requests (resident_id, created_at DESC);
CREATE INDEX requests_created ON requests (created_at);
CREATE TABLE request_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_id uuid NOT NULL REFERENCES requests,
  status text NOT NULL, reason text, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments (
  request_id uuid PRIMARY KEY REFERENCES requests, centavos integer NOT NULL CHECK (centavos > 0),
  reference text NOT NULL UNIQUE, recorded_by text NOT NULL REFERENCES "user",
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), starts_at timestamptz NOT NULL UNIQUE,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100)
);
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests,
  slot_id uuid NOT NULL REFERENCES slots,
  state text NOT NULL DEFAULT 'booked' CHECK (state IN ('booked','checked_in','cancelled','completed','no_show'))
);
CREATE UNIQUE INDEX booking_one_active ON bookings (request_id) WHERE state IN ('booked','checked_in');
CREATE INDEX booking_slot ON bookings (slot_id, state);
CREATE TABLE queue_counter (day date PRIMARY KEY, last_number integer NOT NULL);
CREATE TABLE queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), day date NOT NULL, number integer NOT NULL,
  request_id uuid NOT NULL REFERENCES requests, booking_id uuid UNIQUE REFERENCES bookings,
  kind text NOT NULL CHECK (kind IN ('filing','pickup')),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','serving','completed','no_show')),
  UNIQUE (day, number)
);
CREATE UNIQUE INDEX queue_one_active ON queue (request_id) WHERE state IN ('waiting','serving');
CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, resident_id text NOT NULL REFERENCES "user",
  request_id uuid NOT NULL REFERENCES requests, message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX notifications_inbox ON notifications (resident_id, created_at DESC);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id text,
  action text NOT NULL, entity text NOT NULL, target_id text NOT NULL,
  outcome text NOT NULL DEFAULT 'success', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit events are append-only'; END;
$$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit();
