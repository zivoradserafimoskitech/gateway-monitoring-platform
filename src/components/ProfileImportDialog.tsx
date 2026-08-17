// Wave 5 / T2: import a vendor register map from CSV — three steps:
//   1. paste/upload the CSV,
//   2. column mapping (auto-detected, editable) + profile details + optional
//      device for live preview,
//   3. preview table with validation errors and live values, then confirm.
// The confirm button stays disabled until every row is valid AND the required
// sourceDocument is filled. Imported profiles are always draft (server-side).
import { useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from "@contracts/devices";

const CANONICAL = ["key", "address", "fc", "type", "scale", "unit", "writable", "min", "max", "description"] as const;
const UNMAPPED = "__none__";

type PreviewResult = {
  headers: string[];
  mapping: Record<string, string>;
  rows: Array<{
    row: number;
    key: string;
    address: number;
    fc: number;
    type: string;
    scale: number;
    unit: string;
    writable: boolean;
    min?: number;
    max?: number;
    description: string;
    errors: string[];
    live?: { key: string; raw?: number; value?: number; error?: string };
  }>;
  errors: string[];
  liveError?: string;
};

export function ProfileImportDialog() {
  const { t } = useI18n();
  const s = t.settings;
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"source" | "mapping" | "preview">("source");
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [brand, setBrand] = useState("");
  const [deviceType, setDeviceType] = useState<string>("bess");
  const [sourceDocument, setSourceDocument] = useState("");

  const meters = trpc.meters.list.useQuery(undefined, { enabled: open });

  const reset = () => {
    setStep("source");
    setCsvText("");
    setHeaders([]);
    setMapping({});
    setPreview(null);
    setDeviceId(null);
    setModel("");
    setLabel("");
    setBrand("");
    setDeviceType("bess");
    setSourceDocument("");
  };

  const previewMut = trpc.profiles.previewImport.useMutation({
    onSuccess: (res) => {
      setPreview(res as PreviewResult);
      setHeaders(res.headers);
      setMapping(res.mapping);
    },
    onError: (e) => toast.error(e.message),
  });

  const importMut = trpc.profiles.importCsv.useMutation({
    onSuccess: () => {
      utils.profiles.list.invalidate();
      toast.success(s.importSuccess);
      setOpen(false);
      reset();
    },
    onError: (e) => toast.error(e.message),
  });

  const analyze = () =>
    previewMut.mutate(
      { csv: csvText },
      { onSuccess: (res) => { setPreview(res as PreviewResult); setHeaders(res.headers); setMapping(res.mapping); setStep("mapping"); } },
    );

  const refreshPreview = () =>
    previewMut.mutate(
      { csv: csvText, mapping, ...(deviceId != null ? { deviceId } : {}) },
      { onSuccess: () => setStep("preview") },
    );

  const rowsValid = preview ? preview.rows.filter((r) => r.errors.length === 0).length : 0;
  const allValid =
    !!preview &&
    preview.rows.length > 0 &&
    preview.errors.length === 0 &&
    preview.rows.every((r) => r.errors.length === 0);
  const canConfirm = allValid && model.trim() !== "" && label.trim() !== "" && sourceDocument.trim() !== "";

  const onFile = (f: File | undefined) => {
    if (!f) return;
    void f.text().then(setCsvText);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Upload className="h-4 w-4" /> {s.csvImport}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{s.importDialogTitle}</DialogTitle>
        </DialogHeader>

        {step === "source" && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-slate-500">{s.importStepSource}</p>
            <div className="space-y-2">
              <Label>{s.importPasteLabel}</Label>
              <Textarea
                rows={10}
                className="font-mono text-xs"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={"key,address,fc,type,scale,unit,writable,min,max,description\nsocPercent,13022,3,u16,0.1,%,false,,,Battery SOC"}
              />
            </div>
            <div className="space-y-2">
              <Label>{s.importUploadLabel}</Label>
              <Input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
          </div>
        )}

        {step === "mapping" && (
          <div className="space-y-4">
            <p className="text-xs font-medium text-slate-500">{s.importStepMapping}</p>
            <p className="text-xs text-slate-500">{s.importRequiredHint}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">{s.importCanonicalColumn}</TableHead>
                  <TableHead>{s.importCsvColumn}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {CANONICAL.map((col) => (
                  <TableRow key={col}>
                    <TableCell className="font-mono text-xs">{col}</TableCell>
                    <TableCell>
                      <Select
                        value={mapping[col] ?? UNMAPPED}
                        onValueChange={(v) =>
                          setMapping((m) => {
                            const next = { ...m };
                            if (v === UNMAPPED) delete next[col];
                            else next[col] = v;
                            return next;
                          })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNMAPPED}>{s.importUnmapped}</SelectItem>
                          {headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{s.importModel}</Label>
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="vendor-x-bess-100" />
              </div>
              <div className="space-y-2">
                <Label>{s.importLabel}</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{s.importBrand}</Label>
                <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{s.importDeviceType}</Label>
                <Select value={deviceType} onValueChange={setDeviceType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEVICE_TYPES.map((dt) => (
                      <SelectItem key={dt} value={dt}>
                        {DEVICE_TYPE_LABELS[dt]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-2">
                <Label>{s.importSourceDocument}</Label>
                <Input
                  value={sourceDocument}
                  onChange={(e) => setSourceDocument(e.target.value)}
                  placeholder="Vendor X Modbus Interface Definition, Rev 2.1"
                />
                <p className="text-xs text-slate-500">{s.importSourceDocumentHint}</p>
              </div>
              <div className="col-span-2 space-y-2">
                <Label>{s.importDevice}</Label>
                <Select value={deviceId != null ? String(deviceId) : UNMAPPED} onValueChange={(v) => setDeviceId(v === UNMAPPED ? null : Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNMAPPED}>{s.importNoDevice}</SelectItem>
                    {(meters.data ?? []).map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.name} ({m.model})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-3">
            <p className="text-xs font-medium text-slate-500">{s.importStepPreview}</p>
            <p className="text-xs text-slate-500">
              {rowsValid} / {preview.rows.length} {s.importRowsValid}
            </p>
            {preview.errors.map((e, i) => (
              <p key={i} className="text-xs font-medium text-red-600">
                {e}
              </p>
            ))}
            {preview.liveError && (
              <p className="text-xs font-medium text-amber-600">
                {s.importLiveFailed}: {preview.liveError}
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.field}</TableHead>
                  <TableHead className="w-20">{s.register}</TableHead>
                  <TableHead className="w-14">{s.functionCode}</TableHead>
                  <TableHead className="w-20">{s.type}</TableHead>
                  <TableHead className="w-16">{s.scale}</TableHead>
                  <TableHead className="w-16">{s.importColWritable}</TableHead>
                  <TableHead className="w-32">{s.importColLive}</TableHead>
                  <TableHead>{s.importColErrors}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((r) => (
                  <TableRow key={r.row} className={r.errors.length > 0 ? "bg-red-50" : undefined}>
                    <TableCell className="font-mono text-xs">{r.key}</TableCell>
                    <TableCell className="font-mono text-xs">{r.address}</TableCell>
                    <TableCell className="text-xs">{String(r.fc).padStart(2, "0")}</TableCell>
                    <TableCell className="text-xs">{r.type}</TableCell>
                    <TableCell className="font-mono text-xs">{r.scale}</TableCell>
                    <TableCell className="text-xs">{r.writable ? "✓" : ""}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.live
                        ? r.live.error
                          ? `⚠ ${r.live.error}`
                          : `${r.live.value}${r.unit ? ` ${r.unit}` : ""} (raw ${r.live.raw})`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-red-600">{r.errors.join("; ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!allValid && <p className="text-xs font-medium text-red-600">{s.importFixErrors}</p>}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step !== "source" && (
            <Button variant="outline" onClick={() => setStep(step === "preview" ? "mapping" : "source")}>
              {s.importBack}
            </Button>
          )}
          {step === "source" && (
            <Button disabled={csvText.trim() === "" || previewMut.isPending} onClick={analyze}>
              {s.importAnalyze}
            </Button>
          )}
          {step === "mapping" && (
            <Button disabled={previewMut.isPending} onClick={refreshPreview}>
              {s.importRefresh}
            </Button>
          )}
          {step === "preview" && (
            <Button
              disabled={!canConfirm || importMut.isPending}
              onClick={() =>
                importMut.mutate({
                  csv: csvText,
                  mapping,
                  model: model.trim(),
                  label: label.trim(),
                  sourceDocument: sourceDocument.trim(),
                  ...(brand.trim() ? { brand: brand.trim() } : {}),
                  deviceType: deviceType as (typeof DEVICE_TYPES)[number],
                })
              }
            >
              {s.importConfirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
