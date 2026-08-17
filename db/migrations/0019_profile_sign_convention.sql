-- Wave 5 / Task 3: bench verification workflow — sign-convention record.
-- The single most dangerous ambiguity on a battery register map is the SIGN
-- of power: vendors disagree whether discharge reads positive or negative,
-- and getting it backwards means the optimiser charges at the evening peak
-- while believing it is discharging. The bench workflow (Settings → Device
-- profiles → Verify) commands a small discharge and records the operator's
-- answer here:
--   discharge_positive = true  → batteryPowerKw reads POSITIVE while discharging
--   discharge_positive = false → batteryPowerKw reads NEGATIVE while discharging
--   discharge_positive = NULL  → never recorded → profiles with a controllable
--                                power setpoint CANNOT be promoted to
--                                bench_verified until this is answered.
-- Non-destructive ADD COLUMN — safe online.
ALTER TABLE device_profiles
  ADD COLUMN discharge_positive boolean NULL;
