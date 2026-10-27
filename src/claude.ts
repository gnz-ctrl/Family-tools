import type { Classification, Draft, Env, MailAnalysis, TaskAssist, Topic } from "./types";

const API = "https://api.anthropic.com/v1/messages";
type Content = Array<{ type: string; input?: unknown; text?: string }>;

async function callClaude(env: Env, body: Record<string, unknown>, maxTokens = 1500): Promise<Content> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY en Cloudflare (Settings → Variables and Secrets).");
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: env.CLAUDE_MODEL, max_tokens: maxTokens, ...body }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Content; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  await trackSpend(env, data.usage);
  return data.content;
}

/** Precio en USD por millón de tokens (entrada, salida). */
const PRICES: Record<string, [number, number]> = { "claude-sonnet-5-5": [2, 10] };
/** Suma el coste de cada llamada para mostrar el saldo que queda (estimado). */
async function trackSpend(env: Env, u?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) {
  if (!u) return;
  const [pin, pout] = PRICES[env.CLAUDE_MODEL] ?? [2, 10];
  const usd = ((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * pin / 1e6 + (u.output_tokens ?? 0) * pout / 1e6;
  try { await env.DB.prepare(`UPDATE settings SET v = CAST(v AS REAL) + ? WHERE k = 'api_spent_usd'`).bind(usd).run(); } catch { /* no bloquear por esto */ }
}

/** Pide a Claude una respuesta en JSON y la extrae del texto. */
async function askJSON<T>(env: Env, system: string, user: string, maxTokens = 1500): Promise<T> {
  const content = await callClaude(env, {
    system: `${system}\n\nResponde SOLO con un objeto JSON válido, sin texto antes ni después y sin bloques de código.`,
    messages: [{ role: "user", content: user }],
  }, maxTokens);
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude no devolvió JSON: " + text.slice(0, 200));
  return JSON.parse(m[0]) as T;
}

const FAMILY = `Eres el asistente de organización de una familia que vive en Berlín (Alemania): Gonzalo y Sabrina,
y sus hijos Valentina, Paul y Santiago. Hablan español; muchos trámites son en alemán.`;

/* ------------------------------------------------------------------------------------------ */

/** Clasifica una entrada libre (texto o email a todo@) en una tarea o nota. */
export async function classify(
  env: Env,
  input: { text: string; sender: string; topics: Topic[]; users: string[]; today: string },
): Promise<Classification> {
  if (env.MOCK_CLAUDE) return mockClassify(input.text, input.sender);
  const topicList = input.topics.map((t) => `- ${t.slug}: ${t.name}`).join("\n");
  return askJSON<Classification>(env, `${FAMILY}
Recibes entradas breves y las colocas en su sitio. Hoy es ${input.today}. Usuarios: ${input.users.join(", ")}. Quien envía: ${input.sender}.
Temas disponibles:
${topicList}
Devuelve: {"kind":"task"|"note"|"event","title":"...","notes":"...","topic_slug":"...","assignee":"email|both","due_date":"YYYY-MM-DD","event_time":"HH:MM o texto","place":"...","topic_status_update":"..."}
Reglas:
- Si es una cita o celebración con fecha (cumpleaños, comida familiar, reunión, visita), kind="event" con due_date = fecha del evento (y event_time/place si se dicen). Los cumpleaños y reuniones de familia van al tema "eventos" si existe.
- Si pide hacer algo, kind="task". Si es solo información, kind="note".
- Título corto y accionable, en español.
- Convierte fechas relativas a YYYY-MM-DD. Sin fecha: omite due_date.
- assignee: email de la persona mencionada; si no se menciona a nadie, el remitente; si es para los dos, "both".
- Si cambia el estado de un tema, resúmelo en topic_status_update.
- No inventes datos.`, input.text.slice(0, 8000), 800);
}

/** Analiza un correo reenviado a inbox@: tema, resumen en español, qué hacer, plazo y eventos. */
export async function analyzeMail(
  env: Env,
  input: { subject: string; text: string; forwardedBy: string; topics: Topic[]; today: string },
): Promise<MailAnalysis> {
  if (env.MOCK_CLAUDE) return mockAnalyze(input.subject, input.text);
  const topicList = input.topics.map((t) => `- ${t.slug}: ${t.name}`).join("\n");
  return askJSON<MailAnalysis>(env, `${FAMILY}
Te llega un correo que alguien de la familia (${input.forwardedBy}) ha reenviado. Analiza el correo ORIGINAL (el reenviado), no el reenvío.
Hoy es ${input.today}. Temas disponibles:
${topicList}
Devuelve:
{"topic_slug":"...","from_name":"quién lo envió originalmente (organización o persona)","from_addr":"email original si aparece",
 "subject":"asunto original","lang":"idioma del correo en español (Alemán, Inglés, Español...)",
 "intent":"qué quieren o qué comunican, 1-2 frases claras en español",
 "todo":"qué tiene que hacer la familia, concreto, en español","due":"YYYY-MM-DD o null",
 "events":[{"title":"en español, con el término original entre paréntesis si es útil","date":"YYYY-MM-DD","time":"solo HH:MM o HH:MM–HH:MM (hora de Berlín), o vacío","who":"a qué hijo/clase afecta","place":"...","note":"qué llevar o preparar"}]}
Reglas:
- events: solo citas con fecha concreta (reuniones, excursiones, fiestas, días sin clase...). Si no hay, [].
- due: el plazo más cercano para actuar (o la fecha del primer evento si hay que decidir algo).
- Fechas sin año: el año que haga que la fecha sea futura respecto a hoy.
- La familia vive en Berlín: las horas del correo son hora de Berlín. Si el texto reenviado muestra otra zona horaria (p. ej. porque se leyó desde el extranjero), conviértela a hora de Berlín.
- En "time" pon solo la hora; duraciones, dudas o comentarios van en "note".
- No inventes datos.`, `Asunto: ${input.subject}\n\n${input.text.slice(0, 12000)}`, 2000);
}

/** Redacta un email para resolver un tema (o responder a un correo recibido). */
export async function draftEmail(
  env: Env,
  input: { topic: Topic; context: string; request: string; lang: string; signer: string; replyTo?: { from: string; subject: string; intent: string; todo: string } },
): Promise<Draft> {
  if (env.MOCK_CLAUDE) return mockDraft(input);
  const langName = ({ de: "alemán", es: "español", en: "inglés" } as Record<string, string>)[input.lang] ?? input.lang;
  const task = input.replyTo
    ? `Redacta la RESPUESTA a este correo recibido de ${input.replyTo.from} (asunto: "${input.replyTo.subject}"). Qué decían: ${input.replyTo.intent}. Lo que hay que hacer: ${input.replyTo.todo}.${input.request ? ` Indicaciones de la familia: ${input.request}` : ""}`
    : input.request
      ? `Redacta un email para conseguir esto: ${input.request}`
      : `Redacta un email para avanzar en el próximo paso del tema: ${input.topic.next_step || "resolver lo pendiente"}.`;
  const d = await askJSON<{ subject: string; body: string }>(env, `${FAMILY}
Redactas emails claros y educados para resolver trámites. Escribe en ${langName}, con el registro adecuado
(en alemán formal: "Sehr geehrte Damen und Herren," y "Mit freundlichen Grüßen" si no hay destinatario concreto).
Usa las referencias del contexto (números de cliente, fechas, importes). No inventes datos: escribe [Platzhalter] / [dato] donde falte uno.
Firma: ${input.signer}.
Devuelve: {"subject":"...","body":"texto completo con saludo y firma"}`,
  `Tema: ${input.topic.name}\n${input.context}\n\n${task}`, 1500);
  return { to: "", subject: d.subject, body: d.body, lang: input.lang };
}

/** Analiza una tarea con su descripción y propone pasos y acciones que la plataforma puede hacer. */
export async function assistTask(
  env: Env,
  input: { task: string; notes: string; due: string | null; who: string; topic: string | null; context: string; today: string },
): Promise<TaskAssist> {
  if (env.MOCK_CLAUDE) return {
    summary: `Prueba simulada para «${input.task}».`, steps: ["Revisar la descripción", "Escribir al organismo"],
    actions: [
      ...(input.topic ? [{ type: "draft_email" as const, label: "Redactar el email", request: input.task, lang: "de" }] : []),
      { type: "create_task", label: "Crear recordatorio", title: "Llamar si no responden", date: "2026-11-20" },
      { type: "set_due", label: "Poner fecha límite", date: "2026-11-15" },
    ],
  };
  const withTopic = input.topic
    ? `- draft_email: {"request":"qué debe conseguir el email","lang":"de|es|en"}: Claude redactará un borrador que la familia revisará y enviará.
- add_fact: {"key":"nombre del dato","value":"valor"}: guardar un dato útil del tema (número de cliente, plazo...). Solo si aparece en la descripción o el contexto.
- set_next_step: {"text":"..."}: actualizar el próximo paso del tema.
- create_event: {"title":"...","date":"YYYY-MM-DD","time":"HH:MM","place":"..."}: una cita con fecha concreta.`
    : `- create_event: {"title":"...","date":"YYYY-MM-DD","time":"HH:MM","place":"..."}: una cita con fecha concreta.`;
  return askJSON<TaskAssist>(env, `${FAMILY}
Ayudas a resolver una tarea concreta. Lee la tarea, su descripción y el contexto del tema, y propone qué hacer.
Hoy es ${input.today}.
Devuelve:
{"summary":"1-2 frases en español: qué hay que hacer y lo más importante a tener en cuenta",
 "steps":["pasos concretos y cortos, en orden (máximo 6)"],
 "actions":[{"type":"...","label":"texto corto del botón, en español", ...campos}]}
Acciones posibles (solo las que de verdad ayuden; máximo 4; puede ser []):
${withTopic}
- create_task: {"title":"...","date":"YYYY-MM-DD o null"}: una subtarea o recordatorio de seguimiento.
- set_due: {"date":"YYYY-MM-DD"}: poner o cambiar la fecha límite de esta tarea, si se deduce un plazo.
Reglas: no inventes datos, plazos ni direcciones; si falta información, dilo en un paso ("Buscar el número de cliente en…").
Las acciones solo se ejecutan si la familia pulsa el botón.`,
  `Tarea: ${input.task}
Para: ${input.who}${input.due ? `\nFecha límite: ${input.due}` : ""}
Descripción: ${input.notes || "(sin descripción)"}
${input.topic ? `Tema: ${input.topic}\n${input.context}` : "Sin tema asignado."}`, 1500);
}

/** Aplica una corrección pedida en lenguaje natural ("más corto", "pásalo a inglés"...). */
export async function reviseEmail(
  env: Env,
  input: { subject: string; body: string; lang: string; instruction: string },
): Promise<Draft> {
  if (env.MOCK_CLAUDE) return { to: "", subject: input.subject, body: input.body + `\n\n[revisado: ${input.instruction}]`, lang: input.lang };
  const d = await askJSON<{ subject: string; body: string; lang: string }>(env, `${FAMILY}
Corriges un borrador de email según la instrucción. Mantén lo que no se pida cambiar. Si se pide otro idioma, tradúcelo entero.
Devuelve: {"subject":"...","body":"...","lang":"de|es|en (idioma final)"}`,
  `Idioma actual: ${input.lang}\nAsunto: ${input.subject}\n\n${input.body}\n\n---\nInstrucción: ${input.instruction}`, 1500);
  return { to: "", subject: d.subject, body: d.body, lang: d.lang || input.lang };
}

/* ------------------------------------------------------------------------------------------
   Respuestas simuladas (solo en local con MOCK_CLAUDE=1)
   ------------------------------------------------------------------------------------------ */
function mockClassify(text: string, sender: string): Classification {
  const slug = /colegio|schule|clase/i.test(text) ? "colegio" : /taller|casa|coche/i.test(text) ? "casa-berlin" : "finanzas";
  return { kind: "task", title: text.slice(0, 80), topic_slug: slug, assignee: sender, due_date: "2026-10-30" };
}
function mockAnalyze(subject: string, text: string): MailAnalysis {
  return {
    topic_slug: "colegio", from_name: "Colegio · Clase 1a", from_addr: "braun@grundschule.example", subject: subject.replace(/^(fwd?|wg):\s*/i, ""),
    lang: "Alemán", intent: "Prueba simulada: " + text.slice(0, 60), todo: "Decidir quién va.", due: "2026-12-03",
    events: [{ title: "Fiesta de Navidad (Weihnachtsfeier) 1a", date: "2026-12-03", time: "15:00–17:00", who: "Hijo 2", place: "Aula 1a", note: "Traer galletas" }],
  };
}
function mockDraft(input: { topic: Topic; lang: string; request: string; signer: string }): Draft {
  return { to: "", subject: `Borrador simulado: ${input.topic.name}`, body: `Sehr geehrte Damen und Herren,\n\n${input.request || input.topic.next_step}\n\nMit freundlichen Grüßen\n${input.signer}`, lang: input.lang };
}
