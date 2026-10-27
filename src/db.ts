import type { Env } from "./types";

/**
 * Migraciones de la base de datos. El Worker las aplica solo, en orden, la primera vez que
 * arranca después de una publicación. Para cambiar la estructura: añadir una entrada al final.
 * Nunca modificar una migración ya publicada.
 */
const MIGRATIONS: string[][] = [
  // 1 · tablas iniciales (ya creadas a mano en la consola; aquí por si se crea una base nueva)
  [
    `CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, icon TEXT, status_summary TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT, topic_id INTEGER REFERENCES topics(id), assignee TEXT NOT NULL DEFAULT 'both', due_date TEXT, status TEXT NOT NULL DEFAULT 'open', recurrence TEXT, source TEXT NOT NULL DEFAULT 'web', created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, completed_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS inbox_items (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, sender TEXT, subject TEXT, body TEXT, ai_result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `INSERT OR IGNORE INTO topics (slug, name) VALUES ('finanzas','Finanzas e impuestos'),('casa-valle','Casa Valle'),('casa-berlin','Casa Berlín'),('colegio','Colegios'),('viajes','Viajes'),('rente-s','Rente y seguros Sabrina'),('rente-g','Rente y seguros Gonzalo'),('morean','Morean')`,
  ],
  // 2 · fichas de tema, historial, correos, eventos, gastos, ajustes
  [
    `ALTER TABLE topics ADD COLUMN next_step TEXT`,
    `ALTER TABLE topics ADD COLUMN sort INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE topics ADD COLUMN email_lang TEXT`,
    `ALTER TABLE topics ADD COLUMN email_to TEXT`,
    `ALTER TABLE topics ADD COLUMN email_ref TEXT`,
    `ALTER TABLE topics ADD COLUMN owner TEXT`,
    `ALTER TABLE tasks ADD COLUMN demo INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS topic_items (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL REFERENCES topics(id), kind TEXT NOT NULL CHECK (kind IN ('fact','contact','doc')), label TEXT NOT NULL, value TEXT, extra TEXT, sort INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL REFERENCES topics(id), at TEXT NOT NULL DEFAULT (date('now')), text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'web', demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS mails (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER REFERENCES topics(id), from_name TEXT, from_addr TEXT, subject TEXT, lang TEXT, received_at TEXT NOT NULL DEFAULT (date('now')), intent TEXT, todo TEXT, due TEXT, state TEXT NOT NULL DEFAULT 'new', body TEXT, forwarded_by TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER REFERENCES topics(id), mail_id INTEGER REFERENCES mails(id), title TEXT NOT NULL, date TEXT NOT NULL, time TEXT, who TEXT, place TEXT, note TEXT, attendee TEXT, in_calendar INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cat TEXT NOT NULL, amount REAL NOT NULL, cycle TEXT NOT NULL CHECK (cycle IN ('mes','trimestre','año')), next TEXT, notice TEXT, sub INTEGER NOT NULL DEFAULT 0, flag TEXT, demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
    `INSERT OR IGNORE INTO settings (k, v) VALUES ('cal_token', lower(hex(randomblob(16))))`,
    `UPDATE topics SET sort = CASE slug WHEN 'finanzas' THEN 1 WHEN 'casa-valle' THEN 2 WHEN 'casa-berlin' THEN 3 WHEN 'colegio' THEN 4 WHEN 'viajes' THEN 5 WHEN 'rente-s' THEN 6 WHEN 'rente-g' THEN 7 WHEN 'morean' THEN 8 ELSE 99 END`,
    `UPDATE topics SET owner = 'sabrina.schaerf@gmail.com' WHERE slug = 'rente-s'`,
  ],
  // 3 · datos de ejemplo para enseñar la plataforma (todo lo marcado demo = 1 se borra con resetDemo)
  seedDemo(),
  // 4 · Morean pasa a ser "Documentos compartidos": archivos pequeños guardados en trozos dentro de D1
  [
    `UPDATE topics SET slug = 'documentos', name = 'Documentos compartidos', status_summary = NULL, next_step = NULL WHERE slug = 'morean'`,
    `CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT, size INTEGER NOT NULL, chunks INTEGER NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS file_chunks (file_id INTEGER NOT NULL REFERENCES files(id), idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, idx))`,
  ],
  // 5 · fin de la demostración: se borran los datos de ejemplo y se añade "Eventos familiares"
  [
    `DELETE FROM events WHERE demo = 1`,
    `DELETE FROM mails WHERE demo = 1`,
    `DELETE FROM history WHERE demo = 1`,
    `DELETE FROM topic_items WHERE demo = 1`,
    `DELETE FROM tasks WHERE demo = 1`,
    `DELETE FROM expenses WHERE demo = 1`,
    `UPDATE topics SET status_summary = NULL, next_step = NULL, email_lang = NULL, email_to = NULL, email_ref = NULL`,
    `INSERT OR IGNORE INTO topics (slug, name) VALUES ('eventos', 'Eventos familiares')`,
    `UPDATE topics SET sort = CASE slug WHEN 'finanzas' THEN 1 WHEN 'casa-valle' THEN 2 WHEN 'casa-berlin' THEN 3 WHEN 'colegio' THEN 4 WHEN 'viajes' THEN 5 WHEN 'eventos' THEN 6 WHEN 'rente-s' THEN 7 WHEN 'rente-g' THEN 8 WHEN 'documentos' THEN 9 ELSE sort END`,
  ],
  // 6 · temas privados (solo los ve una persona) y color de tarjeta por persona
  [
    `ALTER TABLE topics ADD COLUMN private_to TEXT`,
    `CREATE TABLE IF NOT EXISTS topic_colors (email TEXT NOT NULL, topic_id INTEGER NOT NULL REFERENCES topics(id), color TEXT NOT NULL, PRIMARY KEY (email, topic_id))`,
  ],
  // 7 · ayuda de Claude guardada en cada tarea (JSON); la descripción va en tasks.notes
  [
    `ALTER TABLE tasks ADD COLUMN ai TEXT`,
  ],
  // 8 · paneles de cada tema: ocultos por persona y paneles de texto propios; gasto de la API
  [
    `CREATE TABLE IF NOT EXISTS topic_prefs (email TEXT NOT NULL, topic_id INTEGER NOT NULL REFERENCES topics(id), hidden TEXT, PRIMARY KEY (email, topic_id))`,
    `CREATE TABLE IF NOT EXISTS topic_panels (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id INTEGER NOT NULL REFERENCES topics(id), title TEXT NOT NULL, body TEXT, sort INTEGER NOT NULL DEFAULT 0)`,
    `INSERT OR IGNORE INTO settings (k, v) VALUES ('api_spent_usd', '0')`,
  ],
  // 9 · invitaciones de calendario por email: a quién se invitó, versión y respuestas
  [
    `ALTER TABLE events ADD COLUMN invited TEXT`,
    `ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN rsvp TEXT`,
  ],
  // 10 · comentarios en las tareas, para organizarse entre los dos
  [
    `CREATE TABLE IF NOT EXISTS task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), author TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_task_comments ON task_comments(task_id)`,
  ],
  // 11 · zona horaria del lugar de cada evento (null = Pekín)
  [
    `ALTER TABLE events ADD COLUMN tz TEXT`,
  ],
];

let ready: Promise<void> | null = null;

/** Aplica las migraciones pendientes una sola vez por instancia del Worker. */
export function ensureSchema(env: Env): Promise<void> {
  ready ??= migrate(env).catch((e) => { ready = null; throw e; });
  return ready;
}

async function migrate(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM _migrations`).first<{ v: number }>();
  for (let v = (row?.v ?? 0) + 1; v <= MIGRATIONS.length; v++) {
    const stmts = MIGRATIONS[v - 1].map((sql) => env.DB.prepare(sql));
    stmts.push(env.DB.prepare(`INSERT INTO _migrations (version) VALUES (?)`).bind(v));
    await env.DB.batch(stmts); // atómico: o se aplica entera o nada
  }
}

/** Borra todos los datos de ejemplo y deja los temas limpios. */
export async function resetDemo(env: Env) {
  await env.DB.batch([
    `DELETE FROM events WHERE demo = 1`,
    `DELETE FROM mails WHERE demo = 1`,
    `DELETE FROM history WHERE demo = 1`,
    `DELETE FROM topic_items WHERE demo = 1`,
    `DELETE FROM tasks WHERE demo = 1`,
    `DELETE FROM expenses WHERE demo = 1`,
    `UPDATE topics SET status_summary = NULL, next_step = NULL, email_lang = NULL, email_to = NULL, email_ref = NULL`,
  ].map((s) => env.DB.prepare(s)));
}

/* -------------------------------------------------------------------------------------------
   Datos de ejemplo (los mismos que la vista previa)
   ------------------------------------------------------------------------------------------- */
function seedDemo(): string[] {
  const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
  const T = (slug: string) => `(SELECT id FROM topics WHERE slug = ${q(slug)})`;
  const out: string[] = [];

  const topics: Record<string, { status: string; next: string; lang?: string; to?: string; ref?: string }> = {
    finanzas: {
      status: "Resolución del impuesto 2025: devuelven 1.132 € (plazo de recurso hasta el 24 nov). Hay 2 suscripciones por revisar.",
      next: "Recurrir la resolución de 2025 antes del 24 nov y cancelar las suscripciones que no se usan.",
      lang: "de", to: "poststelle@finanzamt.example", ref: "Steuernummer: ••/•••/•••••",
    },
    "casa-berlin": {
      status: "Liquidación de gastos 2025 por revisar. Coche: inspección válida hasta marzo 2027.",
      next: "Revisar la liquidación de gastos antes de pagar y cambiar los neumáticos.",
      lang: "de", to: "verwaltung@hausverwaltung.example", ref: "Wohnung: 3. OG links",
    },
    colegio: {
      status: "Eventos de noviembre pendientes de decidir quién va.",
      next: "Decidir quién va a la reunión de padres del 5 de noviembre.",
      lang: "de", to: "sekretariat@grundschule.example",
    },
    viajes: { status: "Sin viajes reservados.", next: "Planear el próximo viaje.", lang: "es" },
    "rente-g": {
      status: "Reembolso de fisioterapia pendiente. Información de pensión 2025 recibida.",
      next: "Conseguir el reembolso de la fisioterapia y pedir el historial de cotización.",
      lang: "de", to: "service@krankenkasse.example", ref: "Versichertennummer: •••• 4821",
    },
  };
  for (const [slug, t] of Object.entries(topics)) {
    out.push(`UPDATE topics SET status_summary = ${q(t.status)}, next_step = ${q(t.next)}, email_lang = ${q(t.lang ?? "de")}, email_to = ${q(t.to)}, email_ref = ${q(t.ref)} WHERE slug = ${q(slug)}`);
  }

  const items: Array<[string, "fact" | "contact" | "doc", string, string, string?]> = [
    ["finanzas", "fact", "Cuenta principal", "Cuenta conjunta, IBAN DE•• •••• 3310"],
    ["finanzas", "fact", "Tarjeta", "Débito, caduca 08/2028"],
    ["finanzas", "fact", "Nº fiscal", "••/•••/•••••"],
    ["finanzas", "fact", "Declaración 2025", "Presentada el 12 jul 2026"],
    ["finanzas", "fact", "Clase fiscal", "III / V"],
    ["finanzas", "fact", "Devolución 2025", "1.132 €"],
    ["finanzas", "fact", "Plazo de recurso", "Hasta el 24 nov 2026"],
    ["finanzas", "contact", "Banco", "Atención por la app"],
    ["finanzas", "contact", "Finanzamt", "poststelle@finanzamt.example"],
    ["finanzas", "doc", "Resolución 2025 (Steuerbescheid)", "PDF", "oct 2026"],
    ["finanzas", "doc", "Certificado de donaciones", "PDF", "oct 2026"],
    ["finanzas", "doc", "Extracto de septiembre", "PDF", "oct 2026"],

    ["casa-berlin", "fact", "Contrato de alquiler", "Hasta mar 2028"],
    ["casa-berlin", "fact", "Alquiler", "1.480 € (calefacción incluida)"],
    ["casa-berlin", "fact", "Liquidación 2025", "Diferencia a pagar: 214 €"],
    ["casa-berlin", "fact", "Plazo para revisar", "12 meses desde la recepción"],
    ["casa-berlin", "fact", "Coche · Matrícula", "B-•• ••••"],
    ["casa-berlin", "fact", "Coche · Inspección (TÜV)", "Válida hasta mar 2027"],
    ["casa-berlin", "fact", "Coche · Neumáticos de invierno", "Guardados en el taller"],
    ["casa-berlin", "contact", "Administración", "verwaltung@hausverwaltung.example"],
    ["casa-berlin", "contact", "Taller", "termine@werkstatt.example"],
    ["casa-berlin", "doc", "Contrato de alquiler", "PDF", "2025"],
    ["casa-berlin", "doc", "Liquidación de gastos 2025", "PDF", "oct 2026"],

    ["colegio", "fact", "Colegio", "Grundschule (ejemplo)"],
    ["colegio", "fact", "Hijo 1", "Clase 3b · tutora Frau Klein"],
    ["colegio", "fact", "Hijo 2", "Clase 1a · tutor Herr Braun"],
    ["colegio", "fact", "Horario", "8:00–13:30, comedor hasta 16:00"],
    ["colegio", "fact", "Vacaciones de invierno", "2–7 feb 2027"],
    ["colegio", "contact", "Secretaría", "sekretariat@grundschule.example"],
    ["colegio", "contact", "Tutora 3b", "Frau Klein"],
    ["colegio", "doc", "Calendario escolar 2026/27", "PDF", "sep 2026"],

    ["viajes", "fact", "Pasaportes", "Válidos hasta 2029 (adultos), feb 2027 (niños)"],
    ["viajes", "fact", "Tarjetas sanitarias europeas", "Todos, válidas"],

    ["rente-g", "fact", "Seguro médico", "Krankenkasse pública"],
    ["rente-g", "fact", "Nº de asegurado", "•••• 4821"],
    ["rente-g", "fact", "Tipo", "Seguro obligatorio, hijos coasegurados"],
    ["rente-g", "fact", "Nº de seguro social", "•••• 9013"],
    ["rente-g", "fact", "Años cotizados en Alemania", "7"],
    ["rente-g", "fact", "Años en otro país", "Por reconocer"],
    ["rente-g", "contact", "Krankenkasse", "service@krankenkasse.example"],
    ["rente-g", "contact", "Rentenversicherung", "info@rentenversicherung.example"],
    ["rente-g", "doc", "Renteninformation 2025", "PDF", "oct 2026"],
    ["rente-g", "doc", "Receta fisioterapia", "PDF", "sep 2026"],
  ];
  items.forEach(([slug, kind, label, value, extra], i) =>
    out.push(`INSERT INTO topic_items (topic_id, kind, label, value, extra, sort, demo) VALUES (${T(slug)}, '${kind}', ${q(label)}, ${q(value)}, ${q(extra)}, ${i}, 1)`));

  const history: Array<[string, string, string, string]> = [
    ["finanzas", "2026-10-24", "Llega la resolución del impuesto 2025", "email"],
    ["finanzas", "2026-10-23", "Aviso de renovación de la app de idiomas", "email"],
    ["finanzas", "2026-10-18", "Enviado el certificado de donaciones", "web"],
    ["finanzas", "2026-07-12", "Declaración 2025 presentada", "web"],
    ["casa-berlin", "2026-10-25", "Aviso de revisión de detectores de humo", "email"],
    ["casa-berlin", "2026-10-22", "Llega la liquidación de gastos 2025", "email"],
    ["casa-berlin", "2026-10-03", "Pagada la viñeta de Austria", "web"],
    ["colegio", "2026-10-24", "Correo del colegio con eventos de noviembre", "email"],
    ["colegio", "2026-10-15", "Pagada la excursión de la clase 3b", "web"],
    ["rente-g", "2026-10-20", "Enviada la factura de fisioterapia por la app del seguro", "web"],
    ["rente-g", "2026-10-10", "Recibida la información de pensión 2025", "email"],
  ];
  history.forEach(([slug, at, text, src]) =>
    out.push(`INSERT INTO history (topic_id, at, text, source, demo) VALUES (${T(slug)}, ${q(at)}, ${q(text)}, ${q(src)}, 1)`));

  const tasks: Array<[string, string, string, string | null, string?, string?]> = [
    ["Revisar la liquidación de gastos de la casa", "casa-berlin", "both", "2026-10-22"],
    ["Enviar la factura de fisioterapia al seguro", "rente-g", "sabrina.schaerf@gmail.com", "2026-10-27"],
    ["Cambiar a neumáticos de invierno", "casa-berlin", "gportabella@gmail.com", "2026-10-30"],
    ["Pedir certificado de cotización a la Rentenversicherung", "rente-g", "gportabella@gmail.com", null],
    ["Pagar la cuota de la escuela de música", "colegio", "both", null, "2026-10-22", "sabrina.schaerf@gmail.com"],
    ["Mandar al Finanzamt el certificado de donaciones", "finanzas", "gportabella@gmail.com", null, "2026-10-18", "gportabella@gmail.com"],
  ];
  tasks.forEach(([title, slug, who, due, doneAt, doneBy]) =>
    out.push(`INSERT INTO tasks (title, topic_id, assignee, due_date, status, completed_at, completed_by, demo) VALUES (${q(title)}, ${T(slug)}, ${q(who)}, ${q(due)}, ${doneAt ? "'done'" : "'open'"}, ${q(doneAt)}, ${q(doneBy)}, 1)`));

  const mails: Array<{ slug: string; from: string; addr: string; subject: string; lang: string; at: string; intent: string; todo: string; due: string | null; events?: Array<[string, string, string, string, string, string]> }> = [
    { slug: "rente-g", from: "Krankenkasse", addr: "service@krankenkasse.example", subject: "Ihr Erstattungsantrag Physiotherapie – fehlende Unterlagen", lang: "Alemán", at: "2026-10-24",
      intent: "Han recibido la factura de la fisioterapia, pero no pueden pagar el reembolso sin la receta original firmada por el médico.",
      todo: "Enviar la receta original por correo postal o subirla a su app.", due: "2026-11-15" },
    { slug: "finanzas", from: "Finanzamt", addr: "poststelle@finanzamt.example", subject: "Bescheid für 2025 über Einkommensteuer", lang: "Alemán", at: "2026-10-24",
      intent: "Te comunican la resolución del impuesto de 2025: te devuelven 1.132 €. Si no estás de acuerdo, tienes un mes para recurrir.",
      todo: "Comprobar si incluyeron el certificado de donaciones. Si no, recurrir.", due: "2026-11-24" },
    { slug: "finanzas", from: "App de idiomas", addr: "billing@languageapp.example", subject: "Your subscription renews on November 3", lang: "Inglés", at: "2026-10-23",
      intent: "Aviso de que la suscripción anual se renueva sola el 3 de noviembre por 89,99 €.",
      todo: "Decidir si la seguís usando. Si no, cancelarla antes del 2 de noviembre.", due: "2026-11-02" },
    { slug: "casa-berlin", from: "Administración del edificio", addr: "verwaltung@hausverwaltung.example", subject: "Ankündigung: Wartung der Rauchwarnmelder am 06.11.", lang: "Alemán", at: "2026-10-25",
      intent: "Avisan de que el 6 de noviembre, entre las 8 y las 12, un técnico revisará los detectores de humo de todos los pisos.",
      todo: "Que alguien esté en casa esa mañana, o dejar la llave a un vecino y avisarles.", due: "2026-11-06" },
    { slug: "colegio", from: "Colegio · Clase 3b", addr: "klein@grundschule.example", subject: "Einladung zum Elternabend und Termine im November", lang: "Alemán", at: "2026-10-24",
      intent: "La tutora de Hijo 1 invita a la reunión de padres y avisa de la excursión y de un día sin clase en noviembre.",
      todo: "Decidir quién va a la reunión, preparar el almuerzo de la excursión y organizar el 20 de noviembre.", due: "2026-11-05",
      events: [
        ["Reunión de padres (Elternabend) clase 3b", "2026-11-05", "19:00–20:30", "Hijo 1", "Aula 3b", ""],
        ["Excursión clase 3b (Wandertag)", "2026-11-14", "8:00–13:30", "Hijo 1", "Bosque de Grunewald", "Almuerzo y ropa de lluvia; no hace falta que vaya nadie"],
        ["Sin clase (día de formación)", "2026-11-20", "Todo el día", "Hijo 1 y Hijo 2", "", "Hay que organizar quién se queda con los niños"],
      ] },
    { slug: "colegio", from: "Colegio · Dirección", addr: "sekretariat@grundschule.example", subject: "Laternenumzug am 11. November", lang: "Alemán", at: "2026-10-22",
      intent: "Todo el colegio hace el desfile de farolillos de San Martín. Las familias están invitadas.",
      todo: "Hacer o comprar los farolillos y decidir quién acompaña a los niños.", due: "2026-11-11",
      events: [["Desfile de farolillos (Laternenumzug)", "2026-11-11", "17:00", "Hijo 1 y Hijo 2", "Patio del colegio", "Llevar farolillo"]] },
  ];
  for (const m of mails) {
    out.push(`INSERT INTO mails (topic_id, from_name, from_addr, subject, lang, received_at, intent, todo, due, state, demo) VALUES (${T(m.slug)}, ${q(m.from)}, ${q(m.addr)}, ${q(m.subject)}, ${q(m.lang)}, ${q(m.at)}, ${q(m.intent)}, ${q(m.todo)}, ${q(m.due)}, 'new', 1)`);
    for (const [title, date, time, who, place, note] of m.events ?? []) {
      out.push(`INSERT INTO events (topic_id, mail_id, title, date, time, who, place, note, demo) VALUES (${T(m.slug)}, (SELECT MAX(id) FROM mails), ${q(title)}, ${q(date)}, ${q(time)}, ${q(who)}, ${q(place || null)}, ${q(note || null)}, 1)`);
    }
  }

  const expenses: Array<[string, string, number, string, string, string, number, string?]> = [
    ["Alquiler", "Vivienda", 1480, "mes", "2026-11-01", "3 meses", 0],
    ["Electricidad", "Vivienda", 78, "mes", "2026-11-15", "1 mes", 0],
    ["Seguro de hogar", "Seguros", 114, "año", "2027-02-01", "3 meses", 0],
    ["Seguro de responsabilidad civil", "Seguros", 72, "año", "2027-01-01", "3 meses", 0],
    ["Seguro del coche", "Seguros", 486, "año", "2027-01-01", "1 mes, hasta el 30 nov", 0],
    ["Abono de transporte (×2)", "Transporte", 126, "mes", "2026-11-01", "Mensual", 0],
    ["Internet", "Comunicaciones", 39.99, "mes", "2026-11-05", "1 mes", 0],
    ["Móviles (×2)", "Comunicaciones", 29.98, "mes", "2026-11-03", "1 mes", 0],
    ["Tasa de radio y TV", "Comunicaciones", 55.08, "trimestre", "2027-01-15", "—", 0],
    ["Escuela de música", "Niños", 45, "mes", "2026-11-01", "Fin de trimestre", 0],
    ["Gimnasio", "Ocio y suscripciones", 34.9, "mes", "2026-11-01", "1 mes", 0],
    ["Streaming de vídeo", "Ocio y suscripciones", 13.99, "mes", "2026-11-08", "En cualquier momento", 1],
    ["Música (plan familiar)", "Ocio y suscripciones", 17.99, "mes", "2026-11-12", "En cualquier momento", 1],
    ["Almacenamiento en la nube", "Ocio y suscripciones", 2.99, "mes", "2026-11-20", "En cualquier momento", 1],
    ["Periódico digital", "Ocio y suscripciones", 9.99, "mes", "2026-11-02", "En cualquier momento", 1, "Sin abrir desde julio"],
    ["App de idiomas", "Ocio y suscripciones", 89.99, "año", "2026-11-03", "Antes del 2 nov", 1, "Se renueva el 3 nov"],
  ];
  for (const [name, cat, amount, cycle, next, notice, sub, flag] of expenses) {
    out.push(`INSERT INTO expenses (name, cat, amount, cycle, next, notice, sub, flag, demo) VALUES (${q(name)}, ${q(cat)}, ${amount}, ${q(cycle)}, ${q(next)}, ${q(notice)}, ${sub}, ${q(flag)}, 1)`);
  }
  return out;
}
