-- Wave 4 / C30 T1: request/response correlation for the C30 transparent path.
-- A Modbus RTU response carries no start address; without the request
-- parameters the decoder guesses the base and can silently mis-decode values
-- that flow into billing. req_* make each readNow request recoverable;
-- responded_at stamps the correlated response. Non-destructive ADD COLUMN.
ALTER TABLE commands
  ADD COLUMN req_slave int NULL,
  ADD COLUMN req_fc int NULL,
  ADD COLUMN req_start int NULL,
  ADD COLUMN req_quantity int NULL,
  ADD COLUMN responded_at timestamp NULL;
