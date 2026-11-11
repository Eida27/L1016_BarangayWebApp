-- Run after migrations using psql -v runtime=barangay_runtime -f scripts/runtime-grants.sql.
GRANT USAGE ON SCHEMA public TO :"runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", account, session, verification, "twoFactor", "rateLimit" TO :"runtime";
GRANT SELECT, INSERT, UPDATE ON employee, requests, bookings, queue, queue_counter, notifications TO :"runtime";
GRANT SELECT, UPDATE ON services TO :"runtime";
GRANT SELECT, INSERT ON request_history, payments, slots, audit_events TO :"runtime";
GRANT USAGE ON SEQUENCE request_history_id_seq, notifications_id_seq, audit_events_id_seq TO :"runtime";
GRANT UPDATE (capacity) ON slots TO :"runtime";
