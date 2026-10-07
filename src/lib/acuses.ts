import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "./paths";
import { acusesRoot } from "./paths";
import type { Evaluacion } from "./evaluacion";
import type { MaestroRow } from "./csv";
import { leerCorreo } from "./io";

export type Acuse = { mensaje_id: string; para: string; asunto: string; estado: string; cuerpo: string; ruta: string };

const nombreCorto = (n: string): string => n.split(" ")[0] ?? n;

export function formatoValor(valor: number, moneda: string): string {
  return `${moneda} ${valor.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`;
}

function resumenFila(f: Pick<MaestroRow, "id_contrato" | "cliente" | "valor" | "moneda" | "fecha_inicio" | "fecha_fin">, indeterminado = false): string {
  const valor = indeterminado || f.valor === 0 ? "valor por demanda" : formatoValor(f.valor, f.moneda);
  return `${f.id_contrato} con ${f.cliente}: ${valor}, vigente del ${f.fecha_inicio} al ${f.fecha_fin}`;
}

/**
 * Redacta el acuse para el comercial según la regla de gobierno. Es un borrador en out/acuses/:
 * el envío real por correo queda para producción (Exchange/Graph).
 */
export async function escribirAcuse(
  ctx: ToolCtx,
  ev: Evaluacion,
  resultado: { estado: "registrado" | "actualizado" | "duplicado" | "rechazado" | "en_revision"; fila?: MaestroRow },
): Promise<Acuse> {
  const correo = await leerCorreo(ctx, ev.mensaje_id);
  const para = correo?.de ?? ev.comercial.email;
  const saludo = `Hola ${ev.comercial.conocido ? nombreCorto(ev.comercial.nombre) : ""},`.replace(" ,", ",");
  const lineas: string[] = [];
  let estadoAsunto = "";

  switch (resultado.estado) {
    case "registrado": {
      const f = resultado.fila;
      estadoAsunto = "registrado";
      if (f) {
        lineas.push(`Registramos el contrato ${resumenFila(f, ev.contrato?.valor_indeterminado)}.`);
        lineas.push(`Quedó archivado en ${f.ruta_sharepoint}.`);
        if (f.requiere_poliza) lineas.push(`El contrato exige póliza (${f.tipo_poliza.replace(/;/g, ", ")}). Queda pendiente hasta que el corredor la expida: por favor gestiónala y reenvía la póliza a este buzón.`);
      }
      const corregidos = Object.keys(ev.correcciones);
      if (corregidos.length) lineas.push(`La analista ajustó estos campos frente al documento: ${corregidos.join(", ")}.`);
      break;
    }
    case "actualizado": {
      estadoAsunto = "actualizado";
      const cambios = Object.entries(ev.diferencias ?? {}).map(([k, d]) => `${k}: ${String(d?.antes)} → ${String(d?.despues)}`);
      lineas.push(`Actualizamos el contrato ${ev.id_contrato_existente} con los cambios del documento:`);
      lineas.push(...cambios.map((c) => `  - ${c}`));
      if (ev.diferencias?.estado_poliza) lineas.push("Las garantías deben ampliarse: por favor gestiona el ajuste de la póliza con el corredor.");
      break;
    }
    case "duplicado":
      estadoAsunto = "ya estaba registrado";
      lineas.push(`El contrato ${ev.id_contrato_existente} ya estaba en el maestro con los mismos datos. No hicimos ningún cambio.`);
      break;
    case "rechazado":
      estadoAsunto = "no registrado";
      lineas.push(`No registramos nada porque ${(ev.motivo ?? "el correo no trae un contrato").replace(/^sin adjunto de contrato: (.+)$/, "el correo no trae un contrato firmado (adjunto revisado: $1)")}.`);
      lineas.push("Si se trata de un contrato firmado, reenvía el PDF firmado por ambas partes con el asunto [CONTRATO] <Cliente> - <N.º contrato>.");
      break;
    case "en_revision":
      estadoAsunto = "en revisión";
      lineas.push(`Recibimos ${ev.contrato?.id_contrato ?? "el documento"}. Antes de registrarlo, la analista está validando:`);
      lineas.push(...ev.detalle_revision.map((d) => `  - ${d.campo}: ${JSON.stringify(d.valor_propuesto)} (${d.motivo})`));
      lineas.push("Si tienes el dato exacto (por ejemplo, la fecha de firma), respóndenos a este correo.");
      break;
  }
  if (!ev.comercial.conocido) lineas.push("Tu correo no está en la lista de comerciales del proceso; administración lo validará con el área comercial.");

  const asunto = `Re: ${correo?.asunto ?? ev.mensaje_id} — ${estadoAsunto}`;
  const cuerpo = [saludo, "", ...lineas, "", "Acuse automático del buzón de contratos (regla de gobierno)."].join("\n");
  const ruta = `out/acuses/${ev.mensaje_id}.md`;
  await mkdir(acusesRoot(ctx), { recursive: true });
  await writeFile(join(acusesRoot(ctx), `${ev.mensaje_id}.md`), `Para: ${para}\nAsunto: ${asunto}\n\n${cuerpo}\n`, "utf-8");
  return { mensaje_id: ev.mensaje_id, para, asunto, estado: resultado.estado, cuerpo, ruta };
}

export async function listarAcuses(ctx: ToolCtx): Promise<{ mensaje_id: string; contenido: string }[]> {
  if (!existsSync(acusesRoot(ctx))) return [];
  const archivos = (await readdir(acusesRoot(ctx))).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(archivos.map(async (f) => ({ mensaje_id: f.replace(/\.md$/, ""), contenido: await readFile(join(acusesRoot(ctx), f), "utf-8") })));
}
