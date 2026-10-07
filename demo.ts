/**
 * Verificación sin modelo (PRD 6.6): procesa el buzón llamando directamente a las herramientas.
 *   bun run demo.ts
 */
import { rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as contratos from "./src/tools/contratos";
import type { ToolCtx } from "./src/tools/tipos";
import { verificarModulo } from "./scripts/build-modulo";

const directory = import.meta.dir;
const ctx: ToolCtx = { directory, sessionId: "demo" };
const HOY = "2026-09-03";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };
const parse = <T>(s: string): Res<T> => JSON.parse(s) as Res<T>;

type Validacion = { clasificacion: string; motivo?: string; requiere_revision: string[]; comercial_desconocido?: string; notas: string[] };
type Registro = { id_contrato: string | null; accion: string; ruta_archivo: string | null };

const fila = (cols: string[], anchos: number[]) => cols.map((c, i) => c.padEnd(anchos[i])).join(" │ ");
const ANCHOS = [8, 14, 32, 34];

async function procesar(id: string): Promise<void> {
  const ext = parse<{ contrato: unknown }>(await contratos.extraer.execute({ mensaje_id: id }, ctx));
  const val = parse<Validacion>(await contratos.validar.execute({ mensaje_id: id }, ctx));
  const reg = parse<Registro>(await contratos.registrar.execute({ mensaje_id: id }, ctx));
  const clasif = val.ok ? val.data.clasificacion : `error: ${val.error}`;
  const revision = val.ok ? val.data.requiere_revision.join(", ") || "—" : "—";
  const accion = reg.ok ? `${reg.data.accion} ${reg.data.id_contrato ?? ""}`.trim() : reg.error.startsWith("requiere revisión") ? "pendiente de confirmación" : `error: ${reg.error}`;
  console.log(fila([id, clasif, revision, accion], ANCHOS));
  if (val.ok && val.data.motivo) console.log(`           ↳ ${val.data.motivo}`);
  if (val.ok && val.data.comercial_desconocido) console.log(`           ↳ remitente no registrado: ${val.data.comercial_desconocido} (se reporta, no bloquea)`);
  if (!ext.ok && val.ok && val.data.clasificacion !== "rechazado") console.log(`   extraer: ${ext.error}`);
}

async function main(): Promise<void> {
  await rm(join(directory, "out"), { recursive: true, force: true });

  const buzon = parse<{ mensajes: { id: string; tiene_contrato: boolean }[] }>(await contratos.leer_buzon.execute({}, ctx));
  if (!buzon.ok) throw new Error(buzon.error);
  console.log(`\nBuzón: ${buzon.data.mensajes.length} mensajes pendientes\n`);
  console.log(fila(["Mensaje", "Clasificación", "Campos en revisión", "Acción"], ANCHOS));
  console.log("─".repeat(96));
  for (const m of buzon.data.mensajes) await procesar(m.id);

  console.log("\nSegunda pasada: la analista confirma msg-006 (valor 0, fecha fin 2027-08-31)");
  const conf = parse<Registro>(
    await contratos.registrar.execute({ mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true }, ctx),
  );
  console.log(conf.ok ? `  → ${conf.data.accion} ${conf.data.id_contrato} en ${conf.data.ruta_archivo}` : `  → error: ${conf.error}`);

  const pendientes = parse<{ mensajes: unknown[] }>(await contratos.leer_buzon.execute({}, ctx));
  console.log(`  Buzón tras la pasada: ${pendientes.ok ? pendientes.data.mensajes.length : "?"} mensajes pendientes`);

  console.log("\nManejo de errores (HU-6): la herramienta responde { ok: false } y la demo sigue");
  console.log("  ", await contratos.extraer.execute({ mensaje_id: "msg-999" }, ctx));
  console.log("  ", await contratos.alertas.execute({ hoy: "2026-02-31" }, ctx));

  const alert = parse<{ ruta: string }>(await contratos.alertas.execute({ hoy: HOY }, ctx));
  if (!alert.ok) throw new Error(alert.error);
  console.log(`\n${await readFile(join(directory, alert.data.ruta), "utf-8")}`);
  const acuses = (await readdir(join(directory, "out/acuses"))).length;
  console.log(`Acuses redactados para los comerciales: ${acuses} (out/acuses/)\n`);

  console.log("Funciones de producto");
  type Consulta = { total: number; contratos: { id_contrato: string; cliente: string; fecha_fin: string }[] };
  const q = parse<Consulta>(await contratos.consultar.execute({ vence_desde: HOY, vence_hasta: "2026-12-31" }, ctx));
  if (q.ok) console.log(`  Consulta "¿qué vence antes de fin de año?": ${q.data.contratos.map((c) => `${c.id_contrato} (${c.fecha_fin})`).join(", ")}`);
  const p1 = parse<unknown>(await contratos.actualizar_poliza.execute({ id_contrato: "CT-2026-015", estado_poliza: "vigente" }, ctx));
  console.log(`  Póliza sin confirmar: ${p1.ok ? "?" : p1.error}`);
  const p2 = parse<{ antes: string; despues: string }>(
    await contratos.actualizar_poliza.execute({ id_contrato: "CT-2026-015", estado_poliza: "vigente", nota: "Póliza 123-456, Seguros Ficticios", confirmado: true }, ctx),
  );
  console.log(`  Póliza confirmada: ${p2.ok ? `CT-2026-015 ${p2.data.antes} → ${p2.data.despues}` : p2.error}`);
  const a2 = parse<{ polizas_pendientes: unknown[] }>(await contratos.alertas.execute({ hoy: HOY }, ctx));
  if (a2.ok) console.log(`  Pólizas pendientes tras la actualización: ${a2.data.polizas_pendientes.length}`);
  console.log(`\n  Acuse de ejemplo (out/acuses/msg-005.md):\n${(await readFile(join(directory, "out/acuses/msg-005.md"), "utf-8")).replace(/^/gm, "    ")}`);

  const historial = await readFile(join(directory, "out/sharepoint/historial.jsonl"), "utf-8");
  console.log(`historial.jsonl: ${historial.trim().split("\n").length} entradas`);
  console.log(`Módulo reutilizable: ${(await verificarModulo(directory)) ? "sincronizado con la app ✓" : "DESINCRONIZADO — corre bun run build:modulo"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
