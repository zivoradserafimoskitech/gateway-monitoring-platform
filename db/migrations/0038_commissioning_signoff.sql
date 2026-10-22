-- §9.10: commissioning sign-off.
--
-- docs/commissioning.md described the end-to-end procedure well, and that was
-- the whole of it: a document. An installer on a roof had no way to see what
-- had already been done on a previous visit, and nobody at the office could
-- tell which of thirty sites were half-finished. "Did anyone configure the
-- alarms on that site?" was answered by opening four screens and guessing.
--
-- The checklist itself is DERIVED and stored nowhere: every step that can be
-- verified from the system's own data is re-checked on every view and cannot be
-- ticked by hand, because a checklist that only records opinions is a form
-- rather than a tool. See contracts/commissioning.ts.
--
-- This table holds the one thing no query can establish: that a human walked
-- the site, saw it working, and put their name to it.
CREATE TABLE IF NOT EXISTS commissioning_signoffs (
  site_id bigint unsigned NOT NULL PRIMARY KEY,
  -- Free text on purpose: the person signing is often a subcontractor with no
  -- account in this system.
  signed_by_name varchar(255) NOT NULL,
  -- The account that recorded it, which is a different fact from who signed.
  recorded_by bigint unsigned NULL,
  note varchar(1000) NULL,
  -- What the checklist looked like at the moment of signing. Kept because the
  -- derived steps keep re-evaluating: without a snapshot, a site that was
  -- complete at handover and has since lost a gateway would read as though it
  -- had been signed off in that state.
  steps_snapshot json NULL,
  signed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  org_id bigint unsigned,
  KEY commissioning_signoff_org_idx (org_id)
);
