-- Technical KPIs: performance ratio needs the array's DC peak power and the
-- site's irradiance reference device. Additive, nullable.
ALTER TABLE meters ADD COLUMN peak_power_kwp DOUBLE NULL;
ALTER TABLE sites ADD COLUMN irradiance_meter_id BIGINT UNSIGNED NULL;
