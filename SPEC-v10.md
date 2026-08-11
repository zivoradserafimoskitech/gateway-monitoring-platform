# SPEC v10 — Целосен UI edition (REVISED after component discovery)

Контекст: аудитот откри дека поголемиот дел од „missing UI" ВЕЌЕ ПОСТОИ како
компоненти монтирани во апликацијата (v8/v9.1 работа):

| Фичер | Состојба |
|---|---|
| Schedules + peak-shaving + autoCommands (per-meter) | `src/components/EmsPanel.tsx` — монтиран на MeterDetail |
| Optimizer plans viewer | `src/components/EmsPlanCard.tsx` — монтиран на MeterDetail (bess) |
| API Keys | `src/components/ApiKeysCard.tsx` — монтиран на Settings |
| Notification channels + maintenance | `src/components/NotificationChannelsCard.tsx` — монтиран на Settings |
| Organizations | `src/components/OrganizationsCard.tsx` — монтиран на Settings |
| Scheduled reports | `src/components/ReportSchedulesCard.tsx` — монтиран на Reports |
| SCADA single-line diagram | `src/pages/SiteDiagram.tsx` — рута `/sites/:id/diagram` постои |

**Вистинските gaps се само 3:**
1. `/ems` — EMS Control Center како FLEET страница (сега EMS е закопан во MeterDetail).
2. `/ota` — OTA страница ВООПШТО не постои (routers: ota.*, gateways.diagnostics).
3. Dashboard → линк кон SCADA дијаграм (рутата постои, но нема влез од UI).

Stage 0 + 0b (ЗАВРШЕНИ од orchestrator): nav items (BatteryCharging /ems,
CloudUpload /ota), рути во App.tsx, placeholder страници, i18n секции
`ota`, `emsPage`, `dashboardExtra` (EN+MK) — **tsc чист на main (94c3c95)**.

## §0 Конвенции (задолжителни за двата агенти)

- React + TS + Tailwind + shadcn/ui (комплет во `src/components/ui/`) + lucide-react.
- `import { trpc } from "@/providers/trpc"`, `import { useI18n } from "@/i18n"`,
  `import { fmt } from "@/components/shared"` (fmt има и date/time helpers — провери
  го фајлот пред да пишеш свои).
- Стил: копирај од EmsPanel.tsx / MeterDetail.tsx / Reports.tsx (Card + CardHeader +
  CardTitle `text-base`, Table од ui/table, Select од ui/select, Dialog од ui/dialog,
  Button variants). Без нови npm пакети.
- RBAC: `trpc.auth.me.useQuery()` → `user.role`: viewer=read-only (криј mutation
  копчиња), operator/admin=може. Погледни како EmsPanel го прави `canWrite`.
- Invalidation после mutation: `trpc.useUtils()` → `utils.ota.list.invalidate()` итн.
- i18n: КЛУЧЕВИТЕ ВЕЌЕ ПОСТОАТ во `src/i18n/en.ts` + `mk.ts`. **ЗАБРАНЕТО е
  уредување на i18n фајловите** (merge конфликти). Ако ти недостасува клуч —
  искористи најблизок постоечки и пријави го тоа во финалниот извештај.
- **ЗАБРАНЕТО**: уредување на `src/App.tsx`, `src/components/Layout.tsx`,
  backend фајлови (`api/`, `scripts/`), `package.json`, i18n фајлови. Не стартувај
  dev server, не рестартуј ништо, не извршувај scripts/ освен tsc.
- Верификација: `npx tsc -b` мора exit 0 во твојот worktree (node_modules е
  symlink-нат). Тоа е единствениот гејт — main agent прави build + browser тест.
- Комит на твојот branch: `git add -A && git commit -m "v10: <scope>"`.

## §1 Модул A — branch `v10-ems-center` — `/ems` страница

Датотеки што СМЕЕШ да ги уредуваш: **само `src/pages/Ems.tsx`** (placeholder е).
Прочитај ги прво: `src/components/EmsPanel.tsx`, `src/components/EmsPlanCard.tsx`,
`src/pages/MeterDetail.tsx` (како се монтираат), `src/App.tsx` (рута кон
MeterDetail — за „open meter" линк), `src/i18n/en.ts` секции `emsPage` и `ems`.

Структура на страницата:

1. Header: `<h1 className="text-2xl font-bold tracking-tight">{t.emsPage.title}</h1>`
   + `<p className="text-sm text-slate-500">{t.emsPage.subtitle}</p>`.
2. **Meter selector**: `trpc.meters.list.useQuery()` — филтрирај bess/battery
   уреди (погледни како EmsPanel/MeterDetail го добива deviceType; полето е
   `deviceType === "bess"`). Select (ui/select) со label `t.emsPage.selectMeter`.
   Default: првиот bess. Ако нема: empty state `t.emsPage.noBess`.
3. За селектираниот meter:
   - `<EmsPanel meterId={id} deviceType="bess" />` (сам носи schedules + peak +
     autoCommands + RBAC).
   - `<EmsPlanCard meterId={id} />` (optimizer планови, read-only).
   - Линк `t.emsPage.openMeter` → рутата кон MeterDetail (провери во App.tsx,
     веројатно `/meters/:id`) — мал ghost Button со lucide `ExternalLink`.
4. **Fleet commands card** (над или под — препорака: веднаш под header, пред
   per-meter делот, за „control center" feel):
   - `trpc.ems.autoCommands.useQuery({ limit: 20 }, { refetchInterval: 10000 })`
     (БЕЗ meterId → сите уреди на орг).
   - Card со CardTitle: `t.emsPage.fleetCommands` + badge `t.emsPage.live`
     (пулсирачка точка: `<span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"/><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"/></span>`).
   - Table: време (fmt date/time од shared), meter име (map од meters.list;
     fallback `#id`), controlKey, controlValue (kw, 1 децимала), result
     (truncate), origin badge: ако `result` почнува со `plan:` →
     `t.emsPage.originPlan` (blue), `peak:` → `t.emsPage.originPeak` (amber),
     `schedule:` → `t.emsPage.originSchedule` (emerald), инаку
     `t.emsPage.originOther` (slate). Провери ги вистинските префикси —
     `grep -rn '"plan:\\\|plan:\`' api/ scripts/ | head` или читај
     `api/ems/` контролерот; ако префиксот е друг, користи го фактичкиот.
   - Empty: кратка порака (искористи постоечки клуч, на пр. t.ems.autoCommands
     како title или едноставен „—").

## §2 Модул B — branch `v10-ops-ui` — `/ota` страница + Dashboard SCADA линк

Датотеки што СМЕЕШ да ги уредуваш: **`src/pages/Ota.tsx`** (placeholder) и
**`src/pages/Dashboard.tsx`** (само додавка на SCADA линк).

Прочитај ги прво: `api/` routers за `ota` и `gateways` (точни input/output
форми — на пр. `grep -rn "ota" api/router*.ts api/routers/` или каде и да се),
`src/pages/GatewayDetail.tsx` (стил + како се користи gatewayId),
`src/i18n/en.ts` секции `ota` и `dashboardExtra`.

### Ota.tsx

Backend договори (постоечки, probe-верифицирани):
- `trpc.gateways.list.useQuery()` → gateway редови (id + име/serial — провери полиња).
- `trpc.gateways.diagnostics.useQuery({ id })` → MQTT gateway:
  `{ lastSeenAt, msgPerMin, activeOtaJobs, samples5min }`; TCP poller:
  `{ poller: [{ id, polls }] }`. Рендерирај ги ДВЕТЕ форми (условно).
- `trpc.ota.list.useQuery({ gatewayId })` → jobs:
  `{ id, type: "firmware"|"config", payload (json), status: "pending"|"sent"|"ack"|"failed", attempts, error, createdAt }`.
- `trpc.ota.create.useMutation({ gatewayId, type, payload })` — payload:
  firmware `{ version: string, url?: string }`, config `{ pollIntervalMs: number }`.
- `trpc.ota.cancel.useMutation({ id })`.

Структура:
1. Header: `t.ota.title` + `t.ota.subtitle`.
2. Gateway selector (ui/select, label `t.ota.gateway`). Default: првиот.
3. **Diagnostics card** (`t.ota.diagnostics`): grid од stats —
   `t.ota.lastSeenAt` (fmt time или „—"), `t.ota.msgPerMin`,
   `t.ota.activeJobs`, `t.ota.samples5min`; ако `poller` форма:
   `t.ota.pollerStats` + редови `t.ota.device`/`t.ota.polls`.
   refetchInterval 10000.
4. **Jobs card** (`t.ota.jobs` + „New job" копче ако canWrite):
   Table: id, type (`t.ota.firmware`/`t.ota.config`), payload
   (`JSON.stringify`, mono text-xs, truncate max-w), status badge
   (`t.ota.statusPending/Sent/Ack/Failed`; бои: pending=amber, sent=blue,
   ack=emerald, failed=red), attempts, error (truncate, red ако има),
   created (fmt), cancel копче (`t.ota.cancel`, само ако status е
   pending/sent и canWrite; confirm преку `t.ota.cancelConfirm`).
   Empty: `t.ota.empty`. refetchInterval 10000.
5. **New job dialog** (ui/dialog): type select (firmware/config); firmware →
   полиња version (required) + url (`t.ota.urlOptional`); config →
   pollIntervalMs number (`t.ota.pollInterval`). Submit → ota.create →
   invalidate ota.list + gateways.diagnostics → затвори dialog.

### Dashboard.tsx SCADA линк

Прочитај `src/pages/Dashboard.tsx` — најди каде се листаат sites (site
картички/редови). Додади мал линк/button кон `/sites/${site.id}/diagram`
со текст `t.dashboardExtra.openDiagram` (title/tooltip
`t.dashboardExtra.openDiagramHint`) и lucide икона (`Activity` или `Network`).
Минимално, во истиот стил како постоечките акции. Ако Dashboard нема site
листа, стави го линкот на најлогичното место (на пр. site селектор/картичка)
и пријави го изборот.

## §3 Деливерабил од секој агент

Финален одговор: (1) листа на изменети фајлови + branch + commit hash,
(2) `npx tsc -b` резултат, (3) i18n клучеви што недостасуваа (ако има),
(4) одлуки/отстапувања од SPEC (со причина).
