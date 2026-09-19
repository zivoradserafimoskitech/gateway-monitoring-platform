-- §9.4: per-device emergency stop.
--
-- Five things now command plant on their own: the grid connection limit, peak
-- shaving, optimizer plans, schedules and the setpoint watchdog. Until this
-- column there was no way for a person to say "stop touching this device" —
-- the only levers were disabling each feature one at a time and hoping none
-- was missed, which is not a thing to be doing while standing next to an
-- inverter with the covers off.
--
-- Enforcement lives in executeControl, the single chokepoint every one of
-- those writers passes through, and reads this column directly rather than
-- through the meter caches: a stop that takes effect in five minutes is not a
-- stop. A controller added later inherits the lock instead of having to
-- remember it.
ALTER TABLE meters
  ADD COLUMN control_locked_at timestamp NULL,
  ADD COLUMN control_locked_by bigint unsigned NULL,
  ADD COLUMN control_lock_reason varchar(255) NULL;
