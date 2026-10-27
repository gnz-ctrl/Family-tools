/**
 * Construye un email MIME completo para una invitación de calendario, con el formato que usan
 * Google Calendar y Outlook: el .ics va como parte "text/calendar; method=REQUEST" dentro de
 * multipart/alternative (así Gmail muestra la tarjeta con Sí / Quizás / No) y además como adjunto.
 */

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** Base64 en líneas de 76 caracteres (RFC 2045) */
const b64lines = (s: string) => b64(enc.encode(s)).replace(/.{1,76}/g, "$&\r\n");

/** Cabecera con acentos codificada en palabras RFC 2047 cortas (sin partir caracteres) */
function header(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = []; let cur = "";
  for (const ch of s) {
    if (enc.encode(cur + ch).length > 45) { words.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join("\r\n ");
}

export function inviteMime(o: {
  from: string; fromName: string; to: string; subject: string; text: string; html: string;
  ics: string; method: "REQUEST" | "CANCEL"; domain: string;
}): string {
  const mixed = `mix-${crypto.randomUUID()}`, alt = `alt-${crypto.randomUUID()}`;
  const lines = [
    `From: ${header(o.fromName)} <${o.from}>`,
    `To: <${o.to}>`,
    `Subject: ${header(o.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${o.domain}>`,
    "MIME-Version: 1.0",
    "Content-Language: es",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(o.text),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(o.html),
    `--${alt}`,
    `Content-Type: text/calendar; charset=UTF-8; method=${o.method}`,
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(o.ics),
    `--${alt}--`,
    "",
    `--${mixed}`,
    `Content-Type: application/ics; name="${o.method === "CANCEL" ? "cancelacion" : "invitacion"}.ics"`,
    `Content-Disposition: attachment; filename="${o.method === "CANCEL" ? "cancelacion" : "invitacion"}.ics"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(o.ics),
    `--${mixed}--`,
    "",
  ];
  return lines.join("\r\n");
}
