import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { crearLlm } from "./llm/factory";
import { ejecutarTurno, nuevaSesion, type Sesion } from "./agent/cycle";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as contratos from "./tools/contratos";
import { readMaestro } from "./lib/io";
import { listarAcuses } from "./lib/acuses";
import { esIso } from "./lib/fechas";

// Bun carga .env automáticamente. La clave del modelo solo vive en process.env del backend.
const directory = join(import.meta.dir, "..");
process.chdir(directory); // los archivos estáticos se sirven relativos a la raíz del proyecto
const port = Number(process.env.PORT ?? 3000);
const maxIteraciones = Number(process.env.MAX_AGENT_ITERATIONS ?? 25);
const maxTokensSesion = Number(process.env.MAX_SESSION_TOKENS ?? 300_000);
const claveAcceso = process.env.ACCESS_KEY ?? "";

const sesiones = new Map<string, Sesion>();
const llm = crearLlm();

const app = new Hono();

// Si se define ACCESS_KEY, la API exige el encabezado x-access-key (protege la clave del modelo en el link público).
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || !claveAcceso) return next();
  if (c.req.header("x-access-key") !== claveAcceso) return c.json({ error: "clave de acceso inválida" }, 401);
  return next();
});

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: llm?.provider ?? "ninguno", model: llm?.model ?? null, respaldo: llm?.modelos.slice(1) ?? [], requiereClave: Boolean(claveAcceso) }),
);

app.get("/api/sessions/:id", (c) => {
  const s = sesiones.get(c.req.param("id"));
  if (!s) return c.json({ error: "sesión no encontrada" }, 404);
  return c.json({ id: s.id, vista: s.vista, pendientes: s.pendientes, tokens: s.tokens, mensajes: s.mensajes });
});

const ChatBody = z.object({ sessionId: z.string().optional(), message: z.string().trim().min(1).max(4000) });

app.post("/api/chat", async (c) => {
  const body = ChatBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "envía { sessionId?, message } con un mensaje no vacío" }, 400);

  let sesion = body.data.sessionId ? sesiones.get(body.data.sessionId) : undefined;
  if (!sesion) {
    sesion = nuevaSesion(randomUUID());
    sesiones.set(sesion.id, sesion);
  }
  if (!llm) {
    return c.json({
      sessionId: sesion.id,
      reply: "El servidor no tiene configurado un proveedor de modelo (OPENAI_API_KEY o ANTHROPIC_API_KEY). Las herramientas funcionan con `bun run demo`.",
      toolCalls: [],
      needsConfirmation: false,
      error: "sin_proveedor",
    });
  }
  const turno = await ejecutarTurno({ directory, sesion, mensajeUsuario: body.data.message, llm, maxIteraciones, maxTokensSesion });
  return c.json({
    sessionId: sesion.id,
    reply: turno.respuesta,
    toolCalls: turno.herramientas,
    needsConfirmation: turno.necesitaConfirmacion,
    pending: turno.pendientes,
    usage: { turno: turno.uso, sesion: sesion.tokens },
    model: `${llm.provider}/${llm.model}`,
    error: turno.error,
  });
});

/**
 * Vista para la gerencia: reporte de alertas, maestro y acuses. Con ?hoy=YYYY-MM-DD regenera el reporte
 * llamando directamente a la herramienta (sin modelo, sin costo).
 */
app.get("/api/reporte", async (c) => {
  const ctx = { directory, sessionId: "reporte" };
  const hoy = c.req.query("hoy");
  if (hoy) {
    if (!esIso(hoy)) return c.json({ error: "hoy debe tener formato YYYY-MM-DD" }, 400);
    const r = JSON.parse(await contratos.alertas.execute({ hoy }, ctx)) as { ok: boolean; error?: string };
    if (!r.ok) return c.json({ error: r.error }, 400);
  }
  const rutaAlertas = join(directory, "out", "alertas.md");
  return c.json({
    alertas: existsSync(rutaAlertas) ? await readFile(rutaAlertas, "utf-8") : null,
    maestro: await readMaestro(ctx),
    acuses: await listarAcuses(ctx),
  });
});

/** Reinicia el estado de la demo: borra out/ (maestro, historial, procesados, alertas) y las sesiones. */
app.post("/api/reset", async (c) => {
  await rm(join(directory, "out"), { recursive: true, force: true });
  sesiones.clear();
  return c.json({ ok: true });
});

app.use("/*", serveStatic({ root: "./web" }));

console.log(`Agente de contratos en http://localhost:${port} · proveedor: ${llm ? `${llm.provider}/${llm.model}` : "ninguno"}`);

export default { port, fetch: app.fetch };
