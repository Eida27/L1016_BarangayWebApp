ALTER TABLE "twoFactor" ADD COLUMN "failedVerificationCount" integer DEFAULT 0;
ALTER TABLE "twoFactor" ADD COLUMN "lockedUntil" timestamptz;

-- Better Auth creates a replacement session after the authenticator is verified.
CREATE FUNCTION revoke_pre_mfa_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM session WHERE "userId" = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_pre_mfa_sessions AFTER UPDATE OF "twoFactorEnabled" ON "user"
FOR EACH ROW WHEN (OLD."twoFactorEnabled" IS DISTINCT FROM true AND NEW."twoFactorEnabled" IS TRUE)
EXECUTE FUNCTION revoke_pre_mfa_sessions();
