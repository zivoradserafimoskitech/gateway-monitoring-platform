-- Setpoint deadman (controller-loss watchdog) configuration, per device model.
--
-- Without it, a platform that dies after commanding a discharge leaves the
-- battery holding that setpoint indefinitely — nothing notices, because the
-- component that would notice is the one that died.
--
-- Shape: { "key": "<controllable key>", "value": <number>,
--          "intervalMs": <number>, "deviceTimeoutMs": <number>,
--          "description": "<optional>" }
--
-- NULL means no watchdog, which is every existing profile, so this migration
-- changes no behaviour on its own. The register, the value and the device's own
-- timeout differ per vendor and can only be established against real hardware,
-- so they are filled in during bench verification.
--
-- Non-destructive ADD COLUMN — safe online.
ALTER TABLE device_profiles
  ADD COLUMN watchdog json NULL;
