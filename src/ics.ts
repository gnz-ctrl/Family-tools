import type { User } from "./types";

interface CalEvent { id: number; title: string; date: string; time: string | null; place: string | null; note: string | null; who: string | null; attendee: string | null; topic: string | null }

const ATTEND: Record<string, string> = { g: "Va Gonzalo", s: "Va Sabrina", b: "Vais los dos", n: "No hace falta ir" };

/** Escapa texto según el formato iCalendar y corta líneas largas. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");
const ymd = (d: string) => d.replace(/-/g, "");

/** Genera el calendario suscribible (Google, Apple, Outlook). */
export function buildIcs(events: CalEvent[], _users: User[]): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//sbkperez.me//Family Hub//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Family Hub", "X-WR-TIMEZONE:Europe/Berlin", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    const t = (e.time || "").match(/(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?/);
    lines.push("BEGIN:VEVENT", `UID:event-${e.id}@sbkperez.me`, `DTSTAMP:${now}`);
    if (t) {
      const start = `${ymd(e.date)}T${t[1].padStart(2, "0")}${t[2]}00`;
      const endH = t[3] ? t[3].padStart(2, "0") : String((+t[1] + 1) % 24).padStart(2, "0");
      const end = `${ymd(e.date)}T${endH}${t[4] ?? t[2]}00`;
      lines.push(`DTSTART;TZID=Europe/Berlin:${start}`, `DTEND;TZID=Europe/Berlin:${end}`);
    } else {
      const next = new Date(e.date + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(next.toISOString().slice(0, 10))}`);
    }
    const who = e.attendee ? ATTEND[e.attendee] : "";
    lines.push(`SUMMARY:${esc(e.title + (who ? ` · ${who}` : ""))}`);
    if (e.place) lines.push(`LOCATION:${esc(e.place)}`);
    const desc = [e.who && `Para: ${e.who}`, who, e.note, e.topic && `Tema: ${e.topic}`].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P1D", `DESCRIPTION:${esc("Mañana: " + e.title)}`, "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
