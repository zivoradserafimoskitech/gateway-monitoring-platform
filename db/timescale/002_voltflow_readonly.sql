-- Read-only role for the VoltFlow ERP sync (Supabase edge function
-- sync-kimi-meters). Use this in the TIMESCALE_URL secret instead of
-- the postgres superuser.
-- Apply: docker exec -i enertrek-timescale psql -U postgres -d telemetry -f /docker-entrypoint-initdb.d/002_voltflow_readonly.sql
-- (or pipe this file over psql). CHANGE THE PASSWORD.

DO $$ BEGIN
  CREATE ROLE voltflow_ro LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT CONNECT ON DATABASE telemetry TO voltflow_ro;
GRANT USAGE ON SCHEMA public TO voltflow_ro;
GRANT SELECT ON public.telemetry TO voltflow_ro;
GRANT SELECT ON public.telemetry_daily TO voltflow_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO voltflow_ro;
