-- Commercial tariffs and battery economics are owned by VoltTrade
-- (docs/ems-ownership.md). The tables stay because the gateway's fallback TOU
-- optimiser still reads them; this migration is deliberately NON-destructive
-- and only marks them deprecated. Dropping them is a later, separate step.
ALTER TABLE tariffs COMMENT = 'DEPRECATED: commercial data owned by VoltTrade; kept as fallback TOU profile only';
ALTER TABLE tariff_periods COMMENT = 'DEPRECATED: fallback TOU profile only (see docs/ems-ownership.md)';
ALTER TABLE tariff_prices COMMENT = 'DEPRECATED: fallback TOU profile only (see docs/ems-ownership.md)';
ALTER TABLE battery_economics COMMENT = 'DEPRECATED: battery economics owned by VoltTrade; fallback optimiser input only';
