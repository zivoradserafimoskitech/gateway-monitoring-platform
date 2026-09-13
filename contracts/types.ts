export * from "./errors";

// §9.7 data quality: a day whose sample count falls below this share of the
// device's usual daily count is reported as built on incomplete data.
//
// It lives in contracts/ because both sides of the boundary must agree: the
// server stamps the marker into the scheduled xlsx/pdf, and the browser draws
// the badge in the Reports table. A second hardcoded 0.9 on one side is how
// the emailed report and the screen end up disagreeing about the same day.
export const COVERAGE_OK = 0.9;
