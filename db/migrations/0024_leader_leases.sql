-- Single-writer leases for the loops that command plant.
--
-- docs/ha.md prescribes two app replicas, but the EMS controller, the Modbus
-- poller and the OTA dispatcher run on every replica, each keeping its
-- duplicate-suppression state in a module-level Map. Two replicas therefore
-- each believe they are the only one writing setpoints.
--
-- A lease makes exactly one replica the writer at a time, using the database
-- that is already a hard dependency rather than introducing Redis. A replica
-- that dies stops renewing and another takes over once the lease lapses, so
-- control moves rather than stopping.
--
-- api/lib/leader.ts also creates this table at runtime (CREATE TABLE IF NOT
-- EXISTS) so an installation that has not run migrations still gets the
-- protection. The migration keeps the schema reviewable and in one place.
CREATE TABLE IF NOT EXISTS leader_leases (
  name varchar(64) NOT NULL PRIMARY KEY,
  holder varchar(128) NOT NULL,
  expires_at timestamp NOT NULL
);
