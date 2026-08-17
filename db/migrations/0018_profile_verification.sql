-- Wave 5 / Task 1: profile verification status — the control-plane safety gate.
-- A register map that has not been verified against real hardware is "draft";
-- executeControl refuses to WRITE to a draft profile (reads stay allowed —
-- reading is how you verify). allow_unverified_control is the admin-only
-- commissioning override; every write under it is logged with a WARNING marker.
-- Existing rows become draft — including the seeded SunSpec inverter profiles
-- with a controllable key; they too must be verified before control works.
-- Non-destructive ADD COLUMN — safe online.
ALTER TABLE device_profiles
  ADD COLUMN verification_status ENUM('draft', 'bench_verified', 'field_verified') NOT NULL DEFAULT 'draft',
  ADD COLUMN verified_by BIGINT UNSIGNED NULL,
  ADD COLUMN verified_at timestamp NULL,
  ADD COLUMN verified_notes text NULL,
  ADD COLUMN source_document varchar(500) NULL,
  ADD COLUMN allow_unverified_control boolean NOT NULL DEFAULT false;
