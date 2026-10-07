import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, LlmAdapter, Uso } from "../llm/adapter";
import { buscarHerramienta, herramientas } from "../tools/registry";
import { appendToolLog } from "../lib/io";
import type { ToolCtx } from "../tools/tipos";

export type CampoPendiente = { campo: string; valor_propuesto: unknown; motivo: string };

export type VistaHerramienta = { tipo: "herramienta"; nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado: string };
export type VistaItem =
  | { tipo: "usuario"; texto: string }
  | { tipo: "agente"; texto: string; confirmacion: boolean }
  | { tipo: "error"; texto: string }
  | VistaHerramienta;

export type Sesion = {
  id: string;
  mensajes: ChatMessage[];
  vista: VistaItem[];
  /** Mensajes del buzón que esperan confirmación de la analista, con sus campos en revisión. */
  pendientes: Record<string, CampoPendiente[]>;
  tokens: number;
  actualizada: number;
};

export type Turno = {
  respuesta: string;
  herramientas: VistaHerramienta[];
  necesitaConfirmacion: boolean;
  pendientes: Record<string, CampoPendiente[]>;
  uso: Uso;
  error?: string;
};

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], vista: [], pendientes: {}, tokens: 0, actualizada: Date.now() };
}

/** Comportamiento (agent/prompt.md) + conocimiento (src/knowledge/). Se leen en cada turno: cambiar reglas no exige reiniciar. */
export async function cargarSystemPrompt(directory: string): Promise<string> {
  const prompt = await readFile(join(directory, "agent", "prompt.md"), "utf-8");
  const conocimiento = await readFile(join(directory, "src", "knowledge", "registro-contratos.md"), "utf-8");
  return `${prompt}\n\n---\n\n${conocimiento}`;
}

/** CA3: ¿el mensaje del usuario puede contar como confirmación? Una negación explícita nunca lo es. */
export function esConfirmacion(texto: string): boolean {
  if (/^\s*(no\b|cancela|espera|todav[ií]a no|a[uú]n no)/i.test(texto)) return false;
  return /\b(s[ií]|confirm\w*|de acuerdo|adelante|ok(ay)?|dale|correcto|apruebo|aprobado|procede|registra(lo|los)?)\b/i.test(texto) || /\d/.test(texto);
}

type ResultadoJson = { ok: boolean; data?: Record<string, unknown>; error?: string };

function resumir(resultado: ResultadoJson): string {
  if (!resultado.ok) return resultado.error ?? "error";
  const d = resultado.data ?? {};
  if (Array.isArray(d.mensajes)) return `${d.mensajes.length} mensajes pendientes`;
  if (typeof d.total === "number") return `${d.total} contratos encontrados`;
  if (d.accion === "poliza") return `póliza ${String(d.id_contrato)}: ${String(d.antes)} → ${String(d.despues)}`;
  if (typeof d.accion === "string") return `${d.accion} ${typeof d.id_contrato === "string" ? d.id_contrato : ""}`.trim();
  if (typeof d.clasificacion === "string") {
    const rev = Array.isArray(d.requiere_revision) && d.requiere_revision.length ? ` · revisar ${d.requiere_revision.join(", ")}` : "";
    return `${d.clasificacion}${rev}`;
  }
  if (d.contrato && typeof d.contrato === "object") {
    const c = d.contrato as { tipo_documento?: string; id_contrato?: string | null };
    return `${c.tipo_documento ?? "documento"} ${c.id_contrato ?? "sin número"}`;
  }
  if (typeof d.ruta === "string") return `reporte en ${d.ruta}`;
  return "ok";
}

/** Herramientas que escriben con confirmado=true y el argumento que identifica lo que se confirma. */
const CONFIRMABLES: Record<string, "mensaje_id" | "id_contrato"> = {
  contratos_registrar: "mensaje_id",
  contratos_actualizar_poliza: "id_contrato",
};

function claveDe(nombre: string, args: Record<string, unknown>): string | undefined {
  const campo = CONFIRMABLES[nombre] ?? "mensaje_id";
  return typeof args[campo] === "string" ? (args[campo] as string) : undefined;
}

/** Actualiza la lista de pendientes según lo que devolvieron validar, registrar y actualizar_poliza. */
function seguirPendientes(nombre: string, mensajeId: string | undefined, r: ResultadoJson, pendientes: Record<string, CampoPendiente[]>, args: Record<string, unknown>): void {
  if (!mensajeId) return;
  if (nombre === "contratos_actualizar_poliza") {
    if (r.ok) delete pendientes[mensajeId];
    else if (r.error?.startsWith("requiere confirmación")) {
      pendientes[mensajeId] = [{ campo: "estado_poliza", valor_propuesto: args.estado_poliza, motivo: r.error.replace(/^requiere confirmación: /, "") }];
    }
    return;
  }
  if (nombre === "contratos_validar" && r.ok && r.data) {
    const clasif = r.data.clasificacion;
    const detalle = Array.isArray(r.data.detalle_revision) ? (r.data.detalle_revision as CampoPendiente[]) : [];
    if ((clasif === "nuevo" || clasif === "actualizacion") && detalle.length) pendientes[mensajeId] = detalle;
    else delete pendientes[mensajeId];
  }
  if (nombre === "contratos_registrar") {
    if (r.ok) delete pendientes[mensajeId];
    else if (r.error?.startsWith("requiere revisión") && !pendientes[mensajeId]) pendientes[mensajeId] = [];
  }
}

function argumentosDe(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Un turno del agente: prompt → modelo → herramientas → modelo … hasta que el modelo responde sin pedir herramientas,
 * se alcanza el tope de iteraciones (CA1) o el tope de tokens de la sesión.
 */
export async function ejecutarTurno(opts: {
  directory: string;
  sesion: Sesion;
  mensajeUsuario: string;
  llm: LlmAdapter;
  maxIteraciones: number;
  maxTokensSesion: number;
}): Promise<Turno> {
  const { sesion } = opts;
  const ctx: ToolCtx = { directory: opts.directory, sessionId: sesion.id };
  const system = await cargarSystemPrompt(opts.directory);

  // CA3: solo se puede registrar con confirmado=true lo que estaba pendiente ANTES de este mensaje del usuario.
  const pendientesPrevios = Object.keys(sesion.pendientes);
  const mencionados = pendientesPrevios.filter((id) => opts.mensajeUsuario.includes(id));
  const autorizados = new Set(esConfirmacion(opts.mensajeUsuario) ? (mencionados.length ? mencionados : pendientesPrevios) : []);

  sesion.mensajes.push({ role: "user", content: opts.mensajeUsuario });
  sesion.vista.push({ tipo: "usuario", texto: opts.mensajeUsuario });
  const pendientes = { ...sesion.pendientes };
  const ejecutadas: VistaHerramienta[] = [];
  const uso: Uso = { entrada: 0, salida: 0 };
  const herramientasLlm = herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters }));

  const cerrar = (respuesta: string, error?: string): Turno => {
    sesion.pendientes = pendientes;
    sesion.actualizada = Date.now();
    const necesitaConfirmacion = Object.keys(pendientes).length > 0;
    sesion.vista.push(error ? { tipo: "error", texto: respuesta } : { tipo: "agente", texto: respuesta, confirmacion: necesitaConfirmacion });
    return { respuesta, herramientas: ejecutadas, necesitaConfirmacion, pendientes, uso, error };
  };

  for (let i = 0; i < opts.maxIteraciones; i++) {
    if (sesion.tokens >= opts.maxTokensSesion) {
      return cerrar(`Esta sesión llegó al tope de ${opts.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`, "tope_tokens");
    }
    let respuesta;
    try {
      respuesta = await opts.llm.enviar([{ role: "system", content: system }, ...sesion.mensajes], herramientasLlm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return cerrar(`No pude hablar con el modelo (${opts.llm.provider}): ${msg}. Lo hecho hasta ahora quedó guardado; puedes reintentar.`, "llm");
    }
    uso.entrada += respuesta.uso.entrada;
    uso.salida += respuesta.uso.salida;
    sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida;
    const asistente = respuesta.message;
    sesion.mensajes.push(asistente);

    if (!asistente.tool_calls?.length) return cerrar(asistente.content || "Listo.");

    for (const llamada of asistente.tool_calls) {
      const args = argumentosDe(llamada.arguments);
      const mensajeId = claveDe(llamada.name, args);
      let resultado: string;
      if (llamada.name in CONFIRMABLES && args.confirmado === true && (!mensajeId || !autorizados.has(mensajeId))) {
        resultado = JSON.stringify({
          ok: false,
          error: `confirmación bloqueada: la analista aún no ha confirmado ${mensajeId ?? "este cambio"} en su último mensaje. Muéstrale el cambio, pregúntale y termina el turno.`,
        });
        await appendToolLog(ctx, { herramienta: llamada.name, mensaje_id: mensajeId, ok: false, resumen: "confirmación bloqueada por el backend" });
      } else {
        const h = buscarHerramienta(llamada.name);
        resultado = h ? await h.run(args, ctx) : JSON.stringify({ ok: false, error: `herramienta desconocida: ${llamada.name}` });
      }
      const parsed = JSON.parse(resultado) as ResultadoJson;
      seguirPendientes(llamada.name, mensajeId, parsed, pendientes, args);
      const item: VistaHerramienta = { tipo: "herramienta", nombre: llamada.name, argumentos: args, ok: parsed.ok, resumen: resumir(parsed), resultado: resultado.slice(0, 6000) };
      ejecutadas.push(item);
      sesion.vista.push(item);
      sesion.mensajes.push({ role: "tool", tool_call_id: llamada.id, content: resultado });
    }
  }

  const hechas = ejecutadas.map((h) => `${h.nombre} → ${h.resumen}`).join("\n- ");
  const faltan = Object.keys(pendientes);
  return cerrar(
    `Alcancé el tope de ${opts.maxIteraciones} pasos en este turno.\n\nLo que hice:\n- ${hechas || "(nada)"}\n\n${faltan.length ? `Pendiente de tu confirmación: ${faltan.join(", ")}.` : ""} Escribe "continúa" para seguir.`,
  );
}
