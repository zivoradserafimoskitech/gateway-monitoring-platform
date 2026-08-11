// v8/D3: outbound mail for scheduled reports.
//
// Transports (first match wins):
//   EMAIL_TRANSPORT=log              → log transport (dev/test): the would-be
//                                      email + attachment path goes to the
//                                      server log; nothing leaves the box.
//   SMTP_URL=smtp://user:pass@host   → nodemailer via URL (same as C2 alarms)
//   SMTP_HOST/PORT/USER/PASS/FROM    → nodemailer via discrete env vars
// If nodemailer isn't installed or no SMTP is configured, the log transport is
// used automatically (with a warning) so scheduling never hard-fails on mail.
export interface MailAttachment {
  filename: string;
  content: Buffer;
}

export interface MailResult {
  transport: "log" | "smtp";
  detail: string;
}

async function nodemailerTransport(): Promise<{ sendMail: (msg: Record<string, unknown>) => Promise<unknown> } | null> {
  // Dynamic import evaluated at runtime — nodemailer is an optional dep (same
  // pattern as the C2 alarm email channel), so TS must not resolve it.
  const mod: any = await (Function('return import("nodemailer")')() as Promise<any>).catch(() => null);
  if (!mod) return null;
  const nm = mod.default ?? mod;
  if (process.env.SMTP_URL) return nm.createTransport(process.env.SMTP_URL);
  if (process.env.SMTP_HOST) {
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    const user = process.env.SMTP_USER;
    return nm.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
    });
  }
  return null;
}

export async function sendMail(opts: {
  to: string[];
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<MailResult> {
  const from = process.env.SMTP_FROM || "volttrade-cloud@localhost";
  const attachDesc = (opts.attachments ?? []).map((a) => `${a.filename} (${a.content.length} B)`).join(", ") || "none";
  if (process.env.EMAIL_TRANSPORT !== "log") {
    const transport = await nodemailerTransport();
    if (transport) {
      await transport.sendMail({
        from,
        to: opts.to.join(", "),
        subject: opts.subject,
        text: opts.text,
        attachments: (opts.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content })),
      });
      console.log(`[mailer] smtp sent to=${opts.to.join(",")} subject="${opts.subject}" attachments=${attachDesc}`);
      return { transport: "smtp", detail: `smtp → ${opts.to.join(", ")}` };
    }
    console.warn("[mailer] no usable SMTP config / nodemailer — falling back to log transport");
  }
  console.log(`[mailer] LOG TRANSPORT to=${opts.to.join(",")} subject="${opts.subject}" attachments=${attachDesc}\n${opts.text}`);
  return { transport: "log", detail: "log transport" };
}
