import type { User } from "./types";

export interface CalEvent {
  id: number; title: string; date: string; time: string | null; place: string | null; note: string | null;
  who: string | null; attendee: string | null; topic: string | null; seq?: number | null;
}

const ATTEND: Record<string, string> = { g: "Va Gonzalo", s: "Va Sabrina", b: "Vais los dos", n: "No hace falta ir" };

/** Escapa texto según el formato iCalendar. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Corta líneas a 75 bytes sin partir caracteres UTF-8 (lo exige el estándar). */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = []; let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const ymd = (d: string) => d.replace(/-/g, "");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

const VTIMEZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

/** Fecha y hora del evento ("19:00", "19:00–20:30" o sin hora = día entero). */
function when(e: CalEvent): string[] {
  const t = (e.time || "").match(/(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?/);
  if (t) {
    const start = `${ymd(e.date)}T${t[1].padStart(2, "0")}${t[2]}00`;
    const endH = t[3] ? t[3].padStart(2, "0") : String(Math.min(23, +t[1] + 1)).padStart(2, "0");
    const end = `${ymd(e.date)}T${endH}${t[4] ?? t[2]}00`;
    return [`DTSTART;TZID=Europe/Berlin:${start}`, `DTEND;TZID=Europe/Berlin:${end}`];
  }
  const next = new Date(e.date + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
  return [`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(next.toISOString().slice(0, 10))}`];
}
function details(e: CalEvent): string[] {
  const who = e.attendee ? ATTEND[e.attendee] : "";
  const lines = [`SUMMARY:${esc(e.title)}`];
  if (e.place) lines.push(`LOCATION:${esc(e.place)}`);
  const desc = [e.who && `Para: ${e.who}`, who, e.note, e.topic && `Tema: ${e.topic}`].filter(Boolean).join("\n");
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  return lines;
}
const uid = (e: CalEvent) => `UID:event-${e.id}@sbkperez.me`;

/** Calendario suscribible (Google, Apple, Outlook). */
export function buildIcs(events: CalEvent[], _users: User[]): string {
  const now = stamp();
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//sbkperez.me//Family Hub//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Family Hub", "X-WR-TIMEZONE:Europe/Berlin", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
    ...VTIMEZONE,
  ];
  for (const e of events) {
    const who = e.attendee ? ATTEND[e.attendee] : "";
    lines.push("BEGIN:VEVENT", uid(e), `DTSTAMP:${now}`, ...when(e), ...details({ ...e, title: e.title + (who ? ` · ${who}` : "") }),
      "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P1D", `DESCRIPTION:${esc("Mañana: " + e.title)}`, "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * Invitación (METHOD:REQUEST) o cancelación (METHOD:CANCEL) para enviar por email.
 * Gmail, Apple y Outlook la reconocen y permiten añadirla o responder Sí / No.
 */
export function buildInvite(e: CalEvent, method: "REQUEST" | "CANCEL", organizer: { email: string; name: string }, attendees: User[]): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//sbkperez.me//Family Hub//ES", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    ...VTIMEZONE,
    "BEGIN:VEVENT", uid(e), `DTSTAMP:${stamp()}`, `SEQUENCE:${e.seq ?? 0}`, ...when(e), ...details(e),
    `ORGANIZER;CN=${esc(organizer.name)}:mailto:${organizer.email}`,
    ...attendees.map((a) => `ATTENDEE;CN=${esc(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
  ];
  if (method === "REQUEST") lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P1D", `DESCRIPTION:${esc("Mañana: " + e.title)}`, "END:VALARM");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
