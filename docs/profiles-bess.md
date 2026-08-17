# BESS device profiles: what a battery profile must contain

A checklist for whoever fills in a battery (BESS) profile. The EMS controller
(`api/ems/controller.ts`) — schedules, externally pushed plans, and automatic
peak shaving — is complete, but it can only command what the device's profile
declares. A profile that is missing a required key, or that gets the sign or
the range of the setpoint wrong, does not fail loudly: it silently produces
wrong or refused dispatch.

> **Before you type a single register address:** vendor register maps are
> proprietary documents. Never enter an address you cannot cite against the
> vendor's own documentation, revision included. An invented address on a read
> path yields wrong telemetry; on a **control** path it writes to an unknown
> register on a live battery. "Commonly used" is not a citation. Every
> imported profile must record its `sourceDocument` and starts life as
> `draft` — control is blocked on it until bench verification (see
> [Verification](#5-filling-one-in-import-and-verification)).

## 1. Required read keys

These are the keys the controller and the platform depend on. If a key is
absent from the profile's register map, the function in the "Used by" column
does not work — there is no fallback.

| Key | Used by |
|---|---|
| `socPercent` | **SoC guard** — schedules with `targetSoc` skip discharge at/below and charge at/above the target. Without this key the guard cannot protect anything: it simply never fires and the schedule drives the battery through its limits. |
| `batteryPowerKw` | Monitoring and dispatch verification. Convention for this profile: **positive = discharge, negative = charge** (see §4.1 — vendors disagree, and the profile author must confirm which way the device actually reports). |
| `activePowerKw` | Telemetry; also the grid-exchange source for peak shaving when the BESS itself is the source meter (`import > threshold → discharge`). |

If the hardware cannot expose one of these, say so in the profile notes and
treat the corresponding function as unavailable — do not substitute a
"close enough" key.

## 2. Recommended keys

Not required for dispatch, but expected by the UI, alarm rules and reports.
Add them when the device exposes them:

- `sohPercent` — state of health
- `cellTempMaxC` — hottest cell temperature (derating/overtemp alarms)
- `bmsStatusCode` — BMS operating state (map with `faultCodes` if the vendor
  publishes the enumeration)
- `faultCode` — active fault/alarm code
- `dischargeEnergyTotalKwh`, `chargeEnergyTotalKwh` — lifetime energy
  counters (daily energy reports, throughput accounting)

## 3. Required controllable key: exactly one power setpoint

A BESS profile must declare **one** controllable power setpoint key
(e.g. `activePowerSetpointKw`) in the `controllable` whitelist. Everything
the EMS does — schedules, plans, peak shaving — reduces to writing a kW
value to this one register through `executeAndLog` (whitelist + range clamp
+ RBAC + audit, same as manual control).

The setpoint must satisfy three rules:

1. **Sign convention matches `batteryPowerKw` (§1).** If the profile's
   read key reports discharge as positive, the setpoint must command
   discharge with a positive value. A setpoint whose sign convention differs
   from the read key makes dispatch verification impossible and inverts every
   automatic decision.
2. **`min`/`max` are the NAMEPLATE limits, not the register range.** A 100 kW
   inverter must not get `max: 32767` because the register is i16. The range
   clamp protects the battery only if it expresses the battery's real limits;
   the register's theoretical range tells you nothing about what the hardware
   may safely be asked to do. A 100 kW / 200 kWh unit is
   `min: -100, max: 100` (if the register accepts negatives), even when the
   register itself is signed 16-bit.
3. **It is the only controllable key** — unless the vendor requires a
   mode/enable register as well, in which case stop and read §4.3: that is a
   design change, not profile data.

## 4. Cross-vendor variations you must resolve before saving

The platform does not assume any of the following. Resolve each against the
vendor document *and* the physical unit, and record the outcome in the
profile notes. No values are asserted here for any vendor — that is
deliberate.

### 4.1 Sign convention

Positive power may mean charge **or** discharge — vendors disagree, and some
use different conventions on the read register and the write register of the
same device. Getting it backwards means the optimiser charges at the evening
peak while believing it is discharging: plausible on every dashboard, and
expensive. The bench verification workflow (§5) commands a small discharge
and asks explicitly which way `batteryPowerKw` moved; record the result
(`dischargePositive`) on the profile.

### 4.2 Units and scale factors

Setpoints and power reads variously arrive in kW, W, or percent-of-rating,
with static scale factors of 0.1, 0.01, or 1 being common. A wrong `scale`
is visible the moment you preview the map (SoC reads `6553.5`), but only if
you look. Confirm units against the device display or the vendor tool during
verification, and check both the read keys and the setpoint — they do not
necessarily share a scale.

### 4.3 Mode / enable register — ⚠ design change, not config

Some vendors require a mode or enable register to be written **before** the
power setpoint takes effect (e.g. "external dispatch mode" must be active
first). That means a second controllable key and an *ordered* write sequence:
mode first, then setpoint.

**The current control path does not express this.** `executeAndLog`
(`api/control/execute.ts`) performs a single write per command. If the target
hardware needs sequenced multi-register writes, flag it and stop: this
requires an ordered multi-write mechanism in the control path — a design
change, not something to work around in profile data (e.g. do not "solve" it
by writing the mode register once by hand and hoping it stays set).

### 4.4 32-bit setpoints (FC16) — ⚠ declared, not implemented

Some devices expose the power setpoint as a 32-bit value (i32/u32), which
requires Modbus FC16 (write multiple registers) instead of FC6 (write single
register). The contract already declares this — `fc?: 6 | 16` on the
controllable definition — but `executeControl` currently rejects anything
other than FC6 (`fc16 writes not supported yet (FC6 only)`). If the target
hardware has a 32-bit setpoint, flag it: FC16 support is not implemented and
must be added before the profile can control the device.

### 4.5 Vendor watchdog vs anti-chatter suppression — ⚠ check target hardware, design change

Some BESS revert to idle (or a safe default) unless the setpoint is refreshed
within N seconds — a vendor-side deadman watchdog. This is in **direct
conflict** with the platform's idempotency/anti-chatter logic: identical
(meter, key, value) commands are suppressed for 5 minutes
(`EMS_IDEMPOTENCY_MS`) so steady-state schedules do not rewrite the same
register every tick. That suppression would filter out exactly the refresh
writes the device needs to stay in dispatch.

This point is important and easy to miss. **Check the target hardware for a
watchdog and its timeout.** If one exists and its period is shorter than the
suppression window, flag it: resolving the conflict (a keep-alive path
exempt from idempotency suppression, or a documented decision to disable the
device watchdog where the vendor permits it) is a design change to the EMS
tick and the control path, not profile data.

## 5. Filling one in: import and verification

A profile is filled in from the vendor's register-map document via the
**CSV import** (Settings → Device profiles → Import): columns
`key,address,fc,type,scale,unit,writable,min,max,description`, one row per
register. The import requires `sourceDocument` (vendor document name +
revision — not optional; when a map is wrong six months later, the first
question is which document it came from), shows a live preview of what each
key decodes to *right now* before saving (a wrong scale or byte order is
obvious there), validates against the standard profile rules (no overlapping
addresses, `min < max` on writable keys, supported types only), and always
creates the profile as **`draft`**.

Verification status gates control (`executeAndLog` refuses to write through
a `draft` profile):

| Status | Meaning |
|---|---|
| `draft` | Newly imported / unverified. Telemetry reads work — that is how you verify. Control writes are blocked, except under the admin-only `allowUnverifiedControl` override, which logs a WARNING audit entry on every write while set. |
| `bench_verified` | Set by completing the verification wizard on real hardware: **Settings → Device profiles → Verify** — (1) read verification of every key against plausible ranges, (2) explicit sign-convention check, (3) control round-trip per writable key with raw + scaled values shown, (4) operator confirmation that `min`/`max` match the nameplate. Records `verifiedBy`, `verifiedAt`, firmware/serial in `verifiedNotes`, and clears `allowUnverifiedControl`. |
| `field_verified` | Set manually by an admin after the profile has run correctly on a live site for an agreed period. |

Do not treat verification as paperwork: steps 2 and 4 exist because the two
most dangerous profile errors — inverted sign and register-range `min`/`max`
— both pass every syntactic check and both command real power.

## 6. Checklist

- [ ] `sourceDocument` set (vendor document + revision); profile imported as `draft`
- [ ] `socPercent` mapped and reading plausibly (0–100)
- [ ] `batteryPowerKw` mapped; sign convention confirmed on hardware and recorded
- [ ] `activePowerKw` mapped (or noted why the device cannot provide it)
- [ ] Recommended keys mapped where the device exposes them
- [ ] Exactly one power setpoint key in `controllable`; sign convention matches `batteryPowerKw`
- [ ] Setpoint `min`/`max` = **nameplate**, not register range
- [ ] Units/scale verified on reads **and** on the setpoint (kW vs W vs %; 0.1 / 0.01 / 1)
- [ ] Mode/enable sequencing needed? → flag as design change (§4.3), do not work around
- [ ] 32-bit setpoint / FC16 needed? → flag as not implemented (§4.4)
- [ ] Vendor watchdog present, timeout < 5 min? → flag conflict with anti-chatter suppression (§4.5)
- [ ] Bench verification completed (Settings → Device profiles → Verify) → `bench_verified`
