# Family Hub

Plataforma privada para organizar los temas de la familia: tareas, temas (seguro, pensión, papeles…),
entrada por email y web, y Claude colocando cada cosa en su sitio. Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**MVP incluido:** tareas (pendientes / hechas con historial), temas con "estado actual",
entrada rápida en lenguaje natural, entrada por email, y redacción de emails en alemán.

## Puesta en marcha (una vez, ~30 min)

Necesitas Node.js 20+ y una clave de la API de Anthropic (console.anthropic.com).

```bash
npm install
npx wrangler login
```

### 1. Base de datos
```bash
npx wrangler d1 create family-hub
# copia el database_id que aparece en wrangler.toml
npm run db:init:remote
```

### 2. Configuración
En `wrangler.toml` → `ALLOWED_SENDERS`: los emails de los dos (separados por coma).
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

### 3. Dominio
Cloudflare → Workers → family-hub → Settings → Domains → añadir `sbkperez.me`.

### 4. Login con Cloudflare Access (obligatorio: sin esto la API rechaza todo)
1. Cloudflare → Zero Trust → Access → Applications → *Add application* → Self-hosted.
2. Dominio: `sbkperez.me`. Política: *Allow* → Emails: los vuestros.
3. Método de login: "One-time PIN" (código por email) y/o Google.
4. Copia el **AUD tag** de la aplicación y el nombre de tu equipo (`<equipo>.cloudflareaccess.com`)
   a `ACCESS_AUD` y `ACCESS_TEAM` en `wrangler.toml`, y vuelve a hacer `npm run deploy`.

### 5. Entrada por email
Cloudflare → sbkperez.me → Email → Email Routing → activar.
Routing rules: `todo@sbkperez.me` y `inbox@sbkperez.me` → acción *Send to a Worker* → `family-hub`.
Solo se aceptan emails de las direcciones de `ALLOWED_SENDERS`.

Para Gmail: crea filtros en cada cuenta que reenvíen lo relevante a `inbox@sbkperez.me`.

### 6. En el móvil
Abre `sbkperez.me` → "Añadir a pantalla de inicio".

## Desarrollo local
Crea `.dev.vars` (no se sube a git):
```
DEV_MODE=true
DEV_USER=gportabella@gmail.com
ANTHROPIC_API_KEY=sk-ant-...
```
```bash
npm run db:init:local
npm run dev
```

## Estructura
```
src/index.ts    rutas de la API, handler de email, cron
src/claude.ts   clasificación y redacción con Claude
src/auth.ts     verificación del login de Cloudflare Access
public/         la web (PWA)
schema.sql      tablas y temas iniciales
```

## Próximas fases
2. Documentos (R2), foto de carta → resumen + plazo, resumen semanal por email, backups.
3. Calendario (ICS / Google), contratos y Kündigungsfristen.
4. Viajes y maleta según el tiempo, invitados temporales.
