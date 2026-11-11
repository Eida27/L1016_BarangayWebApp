CREATE TABLE resident_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_number text NOT NULL,
  age integer NOT NULL CHECK (age BETWEEN 0 AND 130),
  sex text NOT NULL CHECK (sex IN ('female', 'male', 'other', 'undisclosed')),
  name_key text NOT NULL,
  contact_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('walk_in', 'csv')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name_key, contact_key)
);
CREATE INDEX resident_register_registered ON resident_register (registered_at);
CREATE INDEX request_history_resolutions ON request_history (at) WHERE status IN ('released', 'rejected');
