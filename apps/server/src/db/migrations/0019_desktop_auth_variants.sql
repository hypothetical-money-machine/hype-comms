-- Authentication callbacks belong to distinct installed desktop identities. Keep the default so
-- the previous server release can continue inserting production transactions during a rolling
-- deployment or rollback, and so transactions already in flight remain production callbacks.
ALTER TABLE authkit_transactions
  ADD COLUMN desktop_auth_variant text NOT NULL DEFAULT 'production'
  CHECK (desktop_auth_variant IN ('production', 'development'));
