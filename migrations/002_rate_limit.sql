CREATE TABLE "rateLimit" (
  id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
