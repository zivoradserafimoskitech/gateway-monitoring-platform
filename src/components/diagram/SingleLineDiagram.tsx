import { useI18n } from "@/i18n";
import { fmt } from "@/components/shared";

// D4: pure-SVG single-line electrical diagram of a site.
// Layout: grid PCC (left) → main breaker → main meter → vertical busbar
// (center) → per-device branches (right), each with its own breaker.
// Coordinates are computed from the branch count, so 0..N devices work.

export interface DiagramDevice {
  id: number;
  name: string;
  model: string;
  deviceType: string; // "meter" | "inverter" | "bess" | ...
  status: "online" | "offline";
  alarm: boolean;
  values: Record<string, number>;
}

// Low-saturation palette, aligned with the app's slate/emerald/amber accents.
const C = {
  line: "#94a3b8",
  bus: "#475569",
  text: "#334155",
  sub: "#64748b",
  online: "#059669", // emerald-600
  inverter: "#d97706", // amber-600
  offline: "#9ca3af", // gray-400
  alarm: "#dc2626", // red-600
  fill: "#ffffff",
} as const;

// Column geometry (SVG user units).
const W = 760;
const ROW_H = 118;
const PCC_X = 80;
const GRID_BKR_X = 152;
const METER_X = 226;
const BUS_X = 340;
const BKR_X = 442;
const DEV_X = 604;
const DEV_W = 150;
const DEV_H = 68;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Power flowing from the device toward the busbar, in kW.
// Inverter: activePowerKw > 0 = generating. BESS: batteryPowerKw > 0 = discharging.
function branchPowerKw(d: DiagramDevice): number | undefined {
  const v = d.deviceType === "bess" ? d.values.batteryPowerKw : d.values.activePowerKw;
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

function statusColor(d: DiagramDevice): string {
  if (d.alarm) return C.alarm;
  if (d.status !== "online") return C.offline;
  return d.deviceType === "inverter" ? C.inverter : C.online;
}

function FlowArrow({ x, y, dir, color }: { x: number; y: number; dir: 1 | -1; color: string }) {
  const w = 9;
  const h = 5.5;
  const points =
    dir === 1
      ? `${x - w},${y - h} ${x + w},${y} ${x - w},${y + h}`
      : `${x + w},${y - h} ${x - w},${y} ${x + w},${y + h}`;
  return <polygon points={points} fill={color} />;
}

function Breaker({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <rect x={x - 8} y={y - 8} width={16} height={16} fill={C.fill} stroke={color} strokeWidth={1.6} />
  );
}

function BatteryGlyph({ x, y, soc, color }: { x: number; y: number; soc: number | undefined; color: string }) {
  const inner = 14;
  const fillW = soc === undefined ? 0 : Math.max(0, Math.min(100, soc)) / 100 * inner;
  return (
    <g>
      <rect x={x - 10} y={y - 6} width={18} height={12} rx={2} fill={C.fill} stroke={color} strokeWidth={1.4} />
      <rect x={x + 8} y={y - 3} width={3} height={6} fill={color} />
      {fillW > 0 && <rect x={x - 8} y={y - 4} width={fillW} height={8} fill={color} opacity={0.75} />}
    </g>
  );
}

function InverterGlyph({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      <rect x={x - 10} y={y - 8} width={20} height={16} rx={2} fill={C.fill} stroke={color} strokeWidth={1.4} />
      <path
        d={`M ${x - 7} ${y} q 3.5 -7 7 0 q 3.5 7 7 0`}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
      />
    </g>
  );
}

export function SingleLineDiagram({
  mainMeter,
  branches,
}: {
  mainMeter: DiagramDevice | null;
  branches: DiagramDevice[];
}) {
  const { t } = useI18n();
  const n = branches.length;
  const H = Math.max(360, 150 + n * ROW_H);
  const midY = H / 2;
  const firstY = midY - ((n - 1) * ROW_H) / 2;
  const lastY = firstY + (n - 1) * ROW_H;
  const busTop = Math.min(midY, n > 0 ? firstY : midY) - 58;
  const busBot = Math.max(midY, n > 0 ? lastY : midY) + 58;

  // Grid exchange: prefer the main meter's live reading (+ = import);
  // otherwise derive it as the negative sum of branch feed-in.
  const netToBus = branches.reduce((s, b) => s + (branchPowerKw(b) ?? 0), 0);
  const meterP = mainMeter ? branchPowerKw(mainMeter) : undefined;
  const gridKw = meterP ?? -netToBus;
  const gridDir: 0 | 1 | -1 = gridKw > 0.05 ? 1 : gridKw < -0.05 ? -1 : 0;
  const gridColor = mainMeter ? statusColor(mainMeter) : C.line;

  // Right edge of the grid feed line: meter circle or straight to the busbar.
  const feedEnd = mainMeter ? METER_X - 22 : BUS_X;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={t.diagram.title}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* ── Grid PCC ─────────────────────────────────────────────── */}
      <circle cx={PCC_X} cy={midY} r={26} fill={C.fill} stroke={C.bus} strokeWidth={2} />
      <text x={PCC_X} y={midY + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.bus}>
        {t.diagram.grid}
      </text>
      <text x={PCC_X} y={midY - 36} textAnchor="middle" fontSize={11} fill={C.sub}>
        {t.diagram.pcc}
      </text>

      {/* PCC → main breaker → (main meter) → busbar */}
      <line x1={PCC_X + 26} y1={midY} x2={GRID_BKR_X - 8} y2={midY} stroke={C.line} strokeWidth={2} />
      <Breaker x={GRID_BKR_X} y={midY} color={gridColor} />
      <line x1={GRID_BKR_X + 8} y1={midY} x2={feedEnd} y2={midY} stroke={C.line} strokeWidth={2} />
      {mainMeter && (
        <line x1={METER_X + 22} y1={midY} x2={BUS_X} y2={midY} stroke={C.line} strokeWidth={2} />
      )}
      {gridDir !== 0 && (
        <>
          <FlowArrow x={(GRID_BKR_X + feedEnd) / 2} y={midY} dir={gridDir} color={gridColor} />
          {mainMeter && (
            <FlowArrow x={(METER_X + 22 + BUS_X) / 2} y={midY} dir={gridDir} color={gridColor} />
          )}
        </>
      )}

      {/* Main meter node */}
      {mainMeter && (
        <g>
          <circle cx={METER_X} cy={midY} r={22} fill={C.fill} stroke={statusColor(mainMeter)} strokeWidth={2} />
          <text x={METER_X} y={midY + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill={statusColor(mainMeter)}>
            M
          </text>
          <text x={METER_X} y={midY - 32} textAnchor="middle" fontSize={11} fill={C.sub}>
            {t.diagram.mainMeter}
          </text>
          <text x={METER_X} y={midY + 42} textAnchor="middle" fontSize={11} fontWeight={600} fill={statusColor(mainMeter)}>
            {truncate(mainMeter.name, 18)}
          </text>
        </g>
      )}

      {/* Grid exchange label */}
      <text
        x={(PCC_X + BUS_X) / 2}
        y={midY + (mainMeter ? 66 : 28)}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill={gridDir === 0 ? C.sub : gridColor}
      >
        {`${fmt(Math.abs(gridKw))} kW · ${
          gridDir === 1 ? t.diagram.import : gridDir === -1 ? t.diagram.export : "—"
        }`}
      </text>

      {/* ── Busbar ───────────────────────────────────────────────── */}
      <line x1={BUS_X} y1={busTop} x2={BUS_X} y2={busBot} stroke={C.bus} strokeWidth={6} strokeLinecap="round" />
      <text x={BUS_X} y={busTop - 10} textAnchor="middle" fontSize={11} fill={C.sub}>
        {t.diagram.busbar}
      </text>

      {/* ── Device branches ──────────────────────────────────────── */}
      {branches.map((b, i) => {
        const y = firstY + i * ROW_H;
        const color = statusColor(b);
        const p = branchPowerKw(b);
        // dir: -1 = device → busbar (generating/discharging), 1 = busbar → device (charging)
        const dir: 0 | 1 | -1 = p === undefined || Math.abs(p) <= 0.05 ? 0 : p > 0 ? -1 : 1;
        const soc = b.deviceType === "bess" ? b.values.socPercent : undefined;
        const today = b.deviceType === "inverter" ? b.values.energyTodayKwh : undefined;
        const stateWord =
          b.deviceType === "bess"
            ? p === undefined || Math.abs(p) <= 0.05
              ? t.devices.idle
              : p > 0
                ? t.devices.discharging
                : t.devices.charging
            : null;
        return (
          <g key={b.id}>
            <line x1={BUS_X} y1={y} x2={BKR_X - 8} y2={y} stroke={C.line} strokeWidth={2} />
            <Breaker x={BKR_X} y={y} color={color} />
            <line x1={BKR_X + 8} y1={y} x2={DEV_X - DEV_W / 2} y2={y} stroke={C.line} strokeWidth={2} />
            {dir !== 0 && (
              <FlowArrow x={(BKR_X + 8 + DEV_X - DEV_W / 2) / 2} y={y} dir={dir} color={color} />
            )}

            {/* device node */}
            <rect
              x={DEV_X - DEV_W / 2}
              y={y - DEV_H / 2}
              width={DEV_W}
              height={DEV_H}
              rx={10}
              fill={C.fill}
              stroke={color}
              strokeWidth={2}
            />
            {b.deviceType === "bess" ? (
              <BatteryGlyph x={DEV_X - DEV_W / 2 + 16} y={y - 14} soc={soc} color={color} />
            ) : (
              <InverterGlyph x={DEV_X - DEV_W / 2 + 16} y={y - 14} color={color} />
            )}
            <text x={DEV_X - DEV_W / 2 + 34} y={y - 16} fontSize={12} fontWeight={600} fill={C.text}>
              {truncate(b.name, 16)}
            </text>
            <text x={DEV_X - DEV_W / 2 + 34} y={y - 2} fontSize={10} fill={C.sub}>
              {truncate(b.model, 20)}
            </text>
            <text x={DEV_X - DEV_W / 2 + 10} y={y + 16} fontSize={12} fontWeight={600} fill={color}>
              {p === undefined ? "—" : `${fmt(Math.abs(p))} kW`}
              {stateWord ? ` · ${stateWord}` : ""}
            </text>
            <text x={DEV_X - DEV_W / 2 + 10} y={y + 30} fontSize={10} fill={C.sub}>
              {b.deviceType === "bess"
                ? `${t.devices.soc}: ${soc === undefined ? "—" : `${fmt(soc, 0)} %`}`
                : `${t.devices.energyToday}: ${fmt(today, 1)} kWh`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
