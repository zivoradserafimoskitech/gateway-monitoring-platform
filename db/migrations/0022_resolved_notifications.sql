-- Return-to-normal notifications.
--
-- alarm_notifications.kind gained a third value. Previously an operator who was
-- paged about an alarm was never told when the condition cleared: resolution
-- updated the alarms row and stopped there, so every page had to be chased
-- manually. The dispatcher now sends a "resolved" notification to exactly the
-- channels that were told about that alarm.
--
-- Widening an enum is non-destructive: existing rows keep their value.
ALTER TABLE alarm_notifications
  MODIFY COLUMN kind enum('initial','escalation','resolved') NOT NULL DEFAULT 'initial';
