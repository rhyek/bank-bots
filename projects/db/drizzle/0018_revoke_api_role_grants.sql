-- Close the Supabase Data API's way into this schema. Supabase grants its API roles (`anon`,
-- `authenticated`) every privilege on every table in `public`, and sets default privileges so each
-- new table gets the same. With RLS off, that made all of them readable and writable over the REST
-- and GraphQL endpoints by anyone holding the project's anon key. Nothing here uses those endpoints:
-- the apps connect directly as the table owner, which needs no grant.
--
-- Hand-written: drizzle-kit does not track grants, so schema.ts and the snapshot are unchanged.
-- The roles exist only on Supabase; on the local test database the loop finds none and does nothing.
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
    -- For tables and sequences this role (the one running the migrations) creates from now on.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
  END LOOP;
END $$;
