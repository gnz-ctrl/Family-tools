export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  ALLOWED_SENDERS: string;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  /** Solo en local (.dev.vars). Nunca en producción. */
  DEV_MODE?: string;
  DEV_USER?: string;
}

export interface Topic {
  id: number;
  slug: string;
  name: string;
  icon: string | null;
  status_summary: string | null;
}

/** Lo que Claude devuelve al clasificar una entrada */
export interface Classification {
  kind: "task" | "note";
  title: string;
  notes?: string;
  topic_slug: string;
  assignee: string; // email o "both"
  due_date?: string; // YYYY-MM-DD
  topic_status_update?: string;
}
