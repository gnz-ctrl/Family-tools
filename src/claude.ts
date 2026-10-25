import type { Classification, Env, Topic } from "./types";

const API = "https://api.anthropic.com/v1/messages";

async function callClaude(env: Env, body: Record<string, unknown>) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: env.CLAUDE_MODEL, max_tokens: 1024, ...body }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { content: Array<{ type: string; input?: unknown; text?: string }> };
}

/**
 * Clasifica una entrada libre (email o texto) en una tarea o nota, con tema, responsable y fecha.
 * Usa una herramienta forzada para obtener JSON estructurado.
 */
export async function classify(
  env: Env,
  input: { text: string; sender: string; topics: Topic[]; users: string[]; today: string },
): Promise<Classification> {
  const topicList = input.topics.map((t) => `- ${t.slug}: ${t.name}`).join("\n");

  const system = `Eres el asistente de organización de una familia que vive en Alemania (Berlín).
Recibes entradas breves (a menudo en español, a veces en alemán o inglés) y las colocas en su sitio.
Hoy es ${input.today}. Usuarios: ${input.users.join(", ")}. Quien envía: ${input.sender}.
Temas disponibles:
${topicList}
Reglas:
- Si la entrada pide hacer algo, kind="task". Si es solo información a recordar, kind="note".
- Título corto y accionable, en español.
- Convierte fechas relativas ("el viernes", "antes de marzo") a YYYY-MM-DD. Si no hay fecha, omítela.
- assignee: el email de la persona mencionada; si no se menciona a nadie, el remitente; si es para ambos, "both".
- Si la entrada cambia el estado de un tema (p.ej. "la Krankenkasse aprobó el reembolso"), resume el nuevo estado en topic_status_update.
- Nunca inventes datos que no estén en la entrada.`;

  const tool = {
    name: "file_item",
    description: "Guarda la entrada clasificada en la plataforma.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["task", "note"] },
        title: { type: "string" },
        notes: { type: "string" },
        topic_slug: { type: "string", enum: input.topics.map((t) => t.slug) },
        assignee: { type: "string" },
        due_date: { type: "string", description: "YYYY-MM-DD" },
        topic_status_update: { type: "string" },
      },
      required: ["kind", "title", "topic_slug", "assignee"],
    },
  };

  const out = await callClaude(env, {
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "file_item" },
    messages: [{ role: "user", content: input.text.slice(0, 8000) }],
  });

  const block = out.content.find((c) => c.type === "tool_use");
  if (!block?.input) throw new Error("Claude no devolvió una clasificación");
  return block.input as Classification;
}

/** Redacta un email formal en alemán a partir de una petición en español (fase 2, ya usable). */
export async function draftGermanEmail(
  env: Env,
  input: { request: string; topic?: Topic; senderName: string },
): Promise<string> {
  const context = input.topic?.status_summary
    ? `Contexto del tema "${input.topic.name}": ${input.topic.status_summary}`
    : "";
  const out = await callClaude(env, {
    system: `Redactas emails formales en alemán para trámites administrativos en Alemania
(Krankenkasse, Finanzamt, Rentenversicherung, Vermieter, Bürgeramt…). Usa "Sehr geehrte Damen und Herren"
si no hay destinatario concreto y "Mit freundlichen Grüßen". Incluye una línea "Betreff:".
No inventes números de póliza ni referencias: deja [Platzhalter] donde falte un dato.
Después del email, añade una breve traducción al español separada por "---".`,
    messages: [{
      role: "user",
      content: `${context}\nRemitente: ${input.senderName}\nLo que necesito: ${input.request}`,
    }],
  });
  return out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
