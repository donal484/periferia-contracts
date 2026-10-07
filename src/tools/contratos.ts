import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { herramienta, type ToolCtx } from "./tipos";
import { alertasPath } from "../lib/paths";
import { REGLAS } from "../lib/reglas";
import type { MaestroRow } from "../lib/csv";
import { ContratoPropuestaSchema } from "../lib/esquemas";
import { buscarDocumento, evaluar, type Evaluacion } from "../lib/evaluacion";
import { esIso, diasEntre } from "../lib/fechas";
import { ErrorExtraccion, extraerContrato } from "../lib/extraction";
import { escribirAcuse } from "../lib/acuses";
import {
  appendHistorial,
  appendToolLog,
  archivarDocumento,
  leerCorreo,
  listarMensajes,
  markProcesado,
  readHistorial,
  readMaestro,
  readProcesados,
  writeMaestro,
} from "../lib/io";

// ---------- utilidades comunes ----------

/** Ejecuta la lógica, registra en out/log.jsonl (RN7) y nunca lanza: devuelve { ok, data } o { ok, error }. */
async function ejecutar<T>(
  ctx: ToolCtx,
  herramientaNombre: string,
  mensajeId: string | undefined,
  fn: () => Promise<T>,
  resumen: (data: T) => string,
): Promise<string> {
  try {
    const data = await fn();
    await appendToolLog(ctx, { herramienta: herramientaNombre, mensaje_id: mensajeId, ok: true, resumen: resumen(data) });
    return JSON.stringify({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await appendToolLog(ctx, { herramienta: herramientaNombre, mensaje_id: mensajeId, ok: false, resumen: error }).catch(() => undefined);
    return JSON.stringify({ ok: false, error });
  }
}

class ErrorNegocio extends Error {}

function vistaEvaluacion(ev: Evaluacion) {
  return {
    clasificacion: ev.clasificacion,
    motivo: ev.motivo,
    id_contrato_existente: ev.id_contrato_existente,
    requiere_revision: ev.requiere_revision,
    detalle_revision: ev.detalle_revision,
    diferencias: ev.diferencias,
    comercial: ev.comercial.nombre,
    comercial_desconocido: ev.comercial.conocido ? undefined : ev.comercial.email,
    notas: ev.notas,
  };
}

// ---------- HU-1 ----------

export const leer_buzon = herramienta({
  description: "Lista los mensajes del buzón que aún no se han procesado, indicando si cada uno trae un contrato adjunto.",
  args: {},
  async execute(_args, ctx) {
    return ejecutar(
      ctx,
      "contratos_leer_buzon",
      undefined,
      async () => {
        const procesados = new Set((await readProcesados(ctx)).map((p) => p.id));
        const mensajes = [];
        for (const id of await listarMensajes(ctx)) {
          if (procesados.has(id)) continue;
          const correo = await leerCorreo(ctx, id);
          if (!correo) continue;
          let tiene_contrato = false;
          let motivo: string | undefined;
          try {
            const doc = await buscarDocumento(ctx, correo);
            if ("rechazo" in doc) motivo = doc.rechazo;
            else tiene_contrato = true;
          } catch (e) {
            motivo = e instanceof Error ? e.message : String(e);
          }
          mensajes.push({
            id: correo.id,
            de: correo.de,
            asunto: correo.asunto,
            fecha: correo.fecha,
            adjuntos: correo.adjuntos,
            tiene_contrato,
            ...(tiene_contrato ? {} : { clasificacion: "rechazado" as const, motivo }),
          });
        }
        return { mensajes, ya_procesados: procesados.size };
      },
      (d) => `${d.mensajes.length} pendientes`,
    );
  },
});

// ---------- HU-2 ----------

export const extraer = herramienta({
  description: "Lee el contrato u otrosí adjunto a un mensaje y devuelve sus campos con confianza por campo, sin inventar valores.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje, p. ej. msg-001"),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_extraer",
      args.mensaje_id,
      async () => {
        const correo = await leerCorreo(ctx, args.mensaje_id);
        if (!correo) throw new ErrorExtraccion(`mensaje no encontrado: ${args.mensaje_id}`);
        const doc = await buscarDocumento(ctx, correo);
        if ("rechazo" in doc) throw new ErrorNegocio(doc.rechazo);
        return { mensaje_id: args.mensaje_id, adjunto: doc.adjunto, remitente: correo.de, contrato: extraerContrato(doc.texto) };
      },
      (d) => `${d.contrato.tipo_documento} ${d.contrato.id_contrato ?? "sin id"}`,
    );
  },
});

// ---------- HU-3 ----------

export const validar = herramienta({
  description: "Clasifica un mensaje como nuevo, actualización, duplicado o rechazado frente al maestro y lista los campos que requieren revisión humana.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje"),
    contrato: ContratoPropuestaSchema.optional().describe(
      "Opcional: valores que propones. Se comparan con el documento; cualquier diferencia queda en requiere_revision.",
    ),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_validar",
      args.mensaje_id,
      async () => vistaEvaluacion(await evaluar(ctx, args.mensaje_id, args.contrato)),
      (d) => `${d.clasificacion}${d.requiere_revision.length ? ` · revisar ${d.requiere_revision.join(", ")}` : ""}`,
    );
  },
});

// ---------- HU-4 ----------

function siguienteAuto(maestro: MaestroRow[], anio: string): string {
  const n = maestro.filter((r) => r.id_contrato.startsWith(`AUTO-${anio}-`)).length + 1;
  return `AUTO-${anio}-${String(n).padStart(3, "0")}`;
}

function filaNueva(ev: Evaluacion, maestro: MaestroRow[], fechaRegistro: string): Omit<MaestroRow, "ruta_sharepoint"> {
  const c = ev.contrato;
  if (!c) throw new ErrorNegocio("no hay contrato para registrar");
  const faltan = (["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"] as const).filter(
    (k) => c[k] === null || c[k] === undefined,
  );
  if (faltan.length) throw new ErrorNegocio(`faltan campos obligatorios: ${faltan.join(", ")}. Pide los valores a la analista y envíalos en contrato.`);
  const anio = (c.fecha_inicio ?? fechaRegistro).slice(0, 4);
  return {
    id_contrato: c.id_contrato ?? siguienteAuto(maestro, anio),
    cliente: c.cliente ?? "",
    nit_cliente: c.nit_cliente ?? "",
    pais: c.pais ?? "CO",
    objeto: (c.objeto ?? "").slice(0, 200),
    valor: c.valor_indeterminado ? 0 : (c.valor ?? 0),
    moneda: c.moneda ?? "COP",
    fecha_inicio: c.fecha_inicio ?? "",
    fecha_fin: c.fecha_fin ?? "",
    requiere_poliza: c.requiere_poliza === true,
    tipo_poliza: c.requiere_poliza ? (c.tipo_poliza ?? "") : "",
    estado_poliza: c.requiere_poliza ? "pendiente" : "no_aplica",
    comercial: ev.comercial.nombre,
    fecha_registro: fechaRegistro,
    fuente: "buzon",
  };
}

export const registrar = herramienta({
  description:
    "Escribe el resultado de un mensaje: inserta o actualiza la fila del maestro, archiva el documento y redacta el acuse al comercial; cierra sin escribir los duplicados y rechazados. Falla si hay campos en revisión y no se envía confirmado=true.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje"),
    contrato: ContratoPropuestaSchema.optional().describe("Opcional: correcciones que la analista dictó para los campos en revisión"),
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó explícitamente los campos en revisión en su último mensaje"),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_registrar",
      args.mensaje_id,
      async () => {
        const confirmado = args.confirmado === true;
        const ev = await evaluar(ctx, args.mensaje_id, args.contrato, confirmado);
        const correo = await leerCorreo(ctx, args.mensaje_id);
        const fechaRegistro = (correo?.fecha ?? new Date().toISOString()).slice(0, 10);

        if (ev.clasificacion === "rechazado" || ev.clasificacion === "duplicado") {
          await markProcesado(ctx, args.mensaje_id, ev.clasificacion);
          const acuse = await escribirAcuse(ctx, ev, { estado: ev.clasificacion });
          return { id_contrato: ev.id_contrato_existente ?? null, accion: ev.clasificacion, ruta_archivo: null, escrito: false, motivo: ev.motivo, acuse: acuse.ruta };
        }

        // RN5 / HU-4: sin confirmación no se escribe nada dudoso.
        if (ev.requiere_revision.length > 0 && !confirmado) {
          await escribirAcuse(ctx, ev, { estado: "en_revision" });
          const detalle = ev.detalle_revision.map((d) => `${d.campo}=${JSON.stringify(d.valor_propuesto)} (${d.motivo})`).join("; ");
          throw new ErrorNegocio(`requiere revisión: ${detalle}`);
        }

        const maestro = await readMaestro(ctx);
        if (!ev.adjunto || !ev.contrato) throw new ErrorNegocio("no hay documento para archivar");

        if (ev.clasificacion === "actualizacion" && ev.fila_existente) {
          const idx = maestro.findIndex((r) => r.id_contrato === ev.fila_existente?.id_contrato);
          const antes = maestro[idx];
          const cambios = ev.diferencias ?? {};
          const nueva: MaestroRow = { ...antes };
          for (const [k, d] of Object.entries(cambios)) Object.assign(nueva, { [k]: d?.despues });
          const ruta = await archivarDocumento(ctx, args.mensaje_id, ev.adjunto, antes.fecha_inicio.slice(0, 4), antes.cliente, `${antes.id_contrato}-${ev.tipo_documento === "otrosi" ? "otrosi" : "version"}-${args.mensaje_id}`);
          maestro[idx] = nueva;
          await writeMaestro(ctx, maestro);
          await appendHistorial(ctx, {
            id_contrato: antes.id_contrato,
            accion: "actualizacion",
            cambios: { ...cambios, documento: ruta, corregido_por_analista: ev.correcciones, aceptado_por_analista: confirmado ? ev.requiere_revision : [] },
            mensaje_id: args.mensaje_id,
          });
          await markProcesado(ctx, args.mensaje_id, "actualizacion");
          const acuse = await escribirAcuse(ctx, ev, { estado: "actualizado", fila: nueva });
          return { id_contrato: antes.id_contrato, accion: "actualizacion", ruta_archivo: ruta, escrito: true, cambios, acuse: acuse.ruta };
        }

        const base = filaNueva(ev, maestro, fechaRegistro);
        const ruta = await archivarDocumento(ctx, args.mensaje_id, ev.adjunto, base.fecha_inicio.slice(0, 4), base.cliente, base.id_contrato);
        const fila: MaestroRow = { ...base, ruta_sharepoint: ruta };
        maestro.push(fila);
        await writeMaestro(ctx, maestro);
        await appendHistorial(ctx, {
          id_contrato: fila.id_contrato,
          accion: "nuevo",
          cambios: { fila, aceptado_por_analista: confirmado ? ev.requiere_revision : [], corregido_por_analista: ev.correcciones },
          mensaje_id: args.mensaje_id,
        });
        await markProcesado(ctx, args.mensaje_id, "nuevo");
        const acuse = await escribirAcuse(ctx, ev, { estado: "registrado", fila });
        return { id_contrato: fila.id_contrato, accion: "nuevo", ruta_archivo: ruta, escrito: true, acuse: acuse.ruta };
      },
      (d) => `${d.accion} ${d.id_contrato ?? ""}`.trim(),
    );
  },
});

// ---------- HU-5 ----------

type ItemAlerta = { id_contrato: string; cliente: string; fecha_fin: string; dias: number; estado_poliza: string; tipo_poliza: string; fecha_registro: string };

function item(r: MaestroRow, hoy: string): ItemAlerta {
  return { id_contrato: r.id_contrato, cliente: r.cliente, fecha_fin: r.fecha_fin, dias: diasEntre(hoy, r.fecha_fin), estado_poliza: r.estado_poliza, tipo_poliza: r.tipo_poliza, fecha_registro: r.fecha_registro };
}

function tabla(items: ItemAlerta[], columnas: [string, (i: ItemAlerta) => string][]): string {
  if (items.length === 0) return "_Ninguno._";
  const cab = `| ${columnas.map((c) => c[0]).join(" | ")} |\n|${columnas.map(() => "---").join("|")}|`;
  return `${cab}\n${items.map((i) => `| ${columnas.map((c) => c[1](i)).join(" | ")} |`).join("\n")}`;
}

export const alertas = herramienta({
  description: "Genera out/alertas.md con los contratos que vencen pronto, las pólizas pendientes y lo registrado desde el corte del maestro.",
  args: {
    hoy: z.string().describe("Fecha de referencia en formato YYYY-MM-DD"),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_alertas",
      undefined,
      async () => {
        if (!esIso(args.hoy)) throw new ErrorNegocio(`fecha inválida: "${args.hoy}" (usa YYYY-MM-DD)`);
        const maestro = await readMaestro(ctx);
        const historial = await readHistorial(ctx);
        const vencen = maestro.map((r) => item(r, args.hoy)).filter((i) => i.dias >= 0 && i.dias <= REGLAS.diasAlertaVencimiento).sort((a, b) => a.dias - b.dias);
        const vencidos_sin_cierre = maestro.map((r) => item(r, args.hoy)).filter((i) => i.dias < 0);
        const polizas_pendientes = maestro.filter((r) => r.requiere_poliza && r.estado_poliza !== "vigente").map((r) => item(r, args.hoy));
        const registrados_desde_corte = maestro.filter((r) => r.fecha_registro > REGLAS.fechaCorte).map((r) => item(r, args.hoy));
        const meta = new Set(["documento", "corregido_por_analista", "aceptado_por_analista"]);
        const actualizados_desde_corte = historial.filter((h) => h.accion === "actualizacion").map((h) => ({ id_contrato: h.id_contrato, mensaje_id: h.mensaje_id, campos: Object.keys(h.cambios).filter((k) => !meta.has(k)) }));

        const md = `# Alertas de contratos — ${args.hoy}

## Vencen en ${REGLAS.diasAlertaVencimiento} días o menos
${tabla(vencen, [["Contrato", (i) => i.id_contrato], ["Cliente", (i) => i.cliente], ["Fin", (i) => i.fecha_fin], ["Días", (i) => String(i.dias)]])}

## Pólizas exigidas que no están vigentes
${tabla(polizas_pendientes, [["Contrato", (i) => i.id_contrato], ["Cliente", (i) => i.cliente], ["Tipo", (i) => i.tipo_poliza.replace(/;/g, ", ")], ["Estado", (i) => i.estado_poliza]])}

## Registrados desde el corte (${REGLAS.fechaCorte})
${tabla(registrados_desde_corte, [["Contrato", (i) => i.id_contrato], ["Cliente", (i) => i.cliente], ["Registrado", (i) => i.fecha_registro]])}
${actualizados_desde_corte.length ? `\nActualizados por otrosí: ${actualizados_desde_corte.map((a) => `${a.id_contrato} (${a.campos.join(", ")})`).join("; ")}.\n` : ""}
## Vencidos sin cierre en el maestro
${tabla(vencidos_sin_cierre, [["Contrato", (i) => i.id_contrato], ["Cliente", (i) => i.cliente], ["Venció", (i) => i.fecha_fin]])}

Estos siguen en el maestro de contratos vigentes; falta confirmar si se liquidaron o se prorrogaron.
`;
        await mkdir(dirname(alertasPath(ctx)), { recursive: true });
        await writeFile(alertasPath(ctx), md, "utf-8");
        return { ruta: "out/alertas.md", vencen, polizas_pendientes, registrados_desde_corte, actualizados_desde_corte, vencidos_sin_cierre };
      },
      (d) => `${d.vencen.length} vencen · ${d.polizas_pendientes.length} pólizas pendientes · ${d.registrados_desde_corte.length} nuevos`,
    );
  },
});

// ---------- Consultas sobre el maestro ----------

const fechaOpcional = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato YYYY-MM-DD").optional();

export const consultar = herramienta({
  description: "Busca contratos en el maestro por cliente, NIT, rango de vencimiento, vigencia en una fecha o estado de póliza; úsala para cualquier pregunta sobre el maestro.",
  args: {
    cliente: z.string().optional().describe("Parte del nombre del cliente o su NIT"),
    vence_desde: fechaOpcional.describe("Fecha fin igual o posterior a esta (YYYY-MM-DD)"),
    vence_hasta: fechaOpcional.describe("Fecha fin igual o anterior a esta (YYYY-MM-DD)"),
    vigente_en: fechaOpcional.describe("Solo contratos vigentes en esta fecha (inicio ≤ fecha ≤ fin)"),
    estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]).optional().describe("Estado de la póliza"),
    pais: z.enum(REGLAS.paises).optional().describe("País del cliente"),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_consultar",
      undefined,
      async () => {
        const texto = args.cliente ? normalizar(args.cliente) : null;
        const filas = (await readMaestro(ctx)).filter(
          (r) =>
            (!texto || normalizar(r.cliente).includes(texto) || r.nit_cliente.includes(texto.replace(/\D/g, "") || "~")) &&
            (!args.vence_desde || r.fecha_fin >= args.vence_desde) &&
            (!args.vence_hasta || r.fecha_fin <= args.vence_hasta) &&
            (!args.vigente_en || (r.fecha_inicio <= args.vigente_en && r.fecha_fin >= args.vigente_en)) &&
            (!args.estado_poliza || r.estado_poliza === args.estado_poliza) &&
            (!args.pais || r.pais === args.pais),
        );
        const totales: Record<string, number> = {};
        for (const r of filas) totales[r.moneda] = (totales[r.moneda] ?? 0) + r.valor;
        return {
          total: filas.length,
          totales_por_moneda: totales,
          contratos: filas
            .sort((a, b) => a.fecha_fin.localeCompare(b.fecha_fin))
            .map((r) => ({
              id_contrato: r.id_contrato,
              cliente: r.cliente,
              nit_cliente: r.nit_cliente,
              pais: r.pais,
              objeto: r.objeto.length > 90 ? `${r.objeto.slice(0, 87)}...` : r.objeto,
              valor: r.valor,
              moneda: r.moneda,
              fecha_inicio: r.fecha_inicio,
              fecha_fin: r.fecha_fin,
              requiere_poliza: r.requiere_poliza,
              tipo_poliza: r.tipo_poliza,
              estado_poliza: r.estado_poliza,
              comercial: r.comercial,
            })),
        };
      },
      (d) => `${d.total} contratos`,
    );
  },
});

function normalizar(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
}

// ---------- Ciclo de vida de la póliza ----------

export const actualizar_poliza = herramienta({
  description: "Cambia el estado de la póliza de un contrato del maestro (por ejemplo, a vigente cuando el corredor la expide); sin confirmado=true solo describe el cambio.",
  args: {
    id_contrato: z.string().describe("Número del contrato en el maestro"),
    estado_poliza: z.enum(["vigente", "pendiente", "vencida"]).describe("Nuevo estado de la póliza"),
    nota: z.string().max(300).optional().describe("Soporte del cambio dictado por la analista, p. ej. número de póliza o aseguradora"),
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó el cambio en su último mensaje"),
  },
  async execute(args, ctx) {
    return ejecutar(
      ctx,
      "contratos_actualizar_poliza",
      undefined,
      async () => {
        const maestro = await readMaestro(ctx);
        const idx = maestro.findIndex((r) => r.id_contrato === args.id_contrato);
        if (idx < 0) throw new ErrorNegocio(`el contrato ${args.id_contrato} no está en el maestro`);
        const fila = maestro[idx];
        if (!fila.requiere_poliza) throw new ErrorNegocio(`${fila.id_contrato} no exige póliza (estado no_aplica); no hay nada que actualizar`);
        if (fila.estado_poliza === args.estado_poliza) throw new ErrorNegocio(`la póliza de ${fila.id_contrato} ya está en estado ${args.estado_poliza}`);
        if (!args.confirmado) {
          throw new ErrorNegocio(
            `requiere confirmación: la póliza de ${fila.id_contrato} (${fila.cliente}, ${fila.tipo_poliza.replace(/;/g, ", ")}) pasaría de ${fila.estado_poliza} a ${args.estado_poliza}${args.nota ? ` con la nota "${args.nota}"` : ""}`,
          );
        }
        const antes = fila.estado_poliza;
        maestro[idx] = { ...fila, estado_poliza: args.estado_poliza };
        await writeMaestro(ctx, maestro);
        await appendHistorial(ctx, {
          id_contrato: fila.id_contrato,
          accion: "poliza",
          cambios: { estado_poliza: { antes, despues: args.estado_poliza }, nota: args.nota ?? "" },
          mensaje_id: "analista",
        });
        return { id_contrato: fila.id_contrato, accion: "poliza", antes, despues: args.estado_poliza };
      },
      (d) => `póliza ${d.id_contrato}: ${d.antes} → ${d.despues}`,
    );
  },
});
