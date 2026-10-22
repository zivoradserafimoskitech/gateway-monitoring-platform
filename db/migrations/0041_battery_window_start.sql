-- §9.5 follow-up: when the discharge window being followed actually began.
--
-- A capacity estimate records the window it was measured over, because a
-- warranty claim is an argument and its working has to be inspectable. A
-- window that spanned more than one sweep was stamped as starting at the
-- previous sweep's cursor — so an estimate from a two-hour discharge could
-- claim to have been measured over the last five minutes of it. The start is
-- now stored with the rest of the open window. NULL for a window opened
-- before this column existed; the tracker falls back to the old stamp then.
ALTER TABLE battery_health
  ADD COLUMN window_started_at timestamp NULL;
