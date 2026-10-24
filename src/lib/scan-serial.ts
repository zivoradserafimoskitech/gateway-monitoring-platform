// Turn whatever a device label's QR/barcode contains into a serial / UID.
// Labels in the field carry: the bare serial, "SN:XXXX" / "S/N XXXX",
// a URL with ?sn= / ?serial= / ?uid=, or several "key:value" lines.
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

export function parseScannedSerial(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text))
    try {
      const u = new URL(text);
      for (const k of ["sn", "serial", "uid", "SN", "id"]) {
        const v = u.searchParams.get(k);
        if (v && SERIAL_RE.test(v.trim())) return v.trim();
      }
      const last = u.pathname.split("/").filter(Boolean).pop();
      return last && SERIAL_RE.test(last) ? last : null;
    } catch {
      /* not a URL */
    }
  for (const line of text.split(/[\r\n;]+/)) {
    const m = /^(?:s\/?n|serial(?:\s*no\.?)?|uid|imei)\s*[:=#]?\s*(.+)$/i.exec(
      line.trim()
    );
    if (m && SERIAL_RE.test(m[1].trim())) return m[1].trim();
  }
  return SERIAL_RE.test(text) ? text : null;
}
