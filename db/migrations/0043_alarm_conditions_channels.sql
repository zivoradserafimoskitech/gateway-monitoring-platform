-- Alarm conditions: rate of change, composite AND/OR, deadband hysteresis;
-- notification channels: SMS (provider from env), Web Push (VAPID), Teams.
-- Additive only: existing rules/channels keep their behaviour (deadband NULL
-- = no hysteresis, conditions NULL for non-composite rules).
ALTER TABLE alarm_rules MODIFY COLUMN operator ENUM('gt','lt','stuck','roc','composite') NOT NULL;
ALTER TABLE alarm_rules ADD COLUMN deadband DOUBLE NULL;
ALTER TABLE alarm_rules ADD COLUMN conditions JSON NULL;
ALTER TABLE notification_channels MODIFY COLUMN type ENUM('webhook','telegram','email','sms','webpush','teams') NOT NULL;
