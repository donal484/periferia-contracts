import { mkdir, readFile, writeFile, copyFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolCtx } from "./paths";
import { buzonRoot, comercialesPath, fixtureMaestroPath, historialPath, logPath, maestroPath, procesadosPath, sharepointRoot } from "./paths";
import { maestroToCsv, parseCsv, type MaestroRow } from "./csv";

export type Correo = {
  id: string;
  de: string;
  para: string;
  asunto: string;
  fecha: string;
  cuerpo: string;
  adjuntos: string[];
};

export type Procesado = { id: string; resultado: string; ts: string };

/** RN6: el fixture es de solo lectura; la primera ejecución lo copia a out/sharepoint/. */
export async function ensureOutDirs(ctx: ToolCtx): Promise<void> {
  await mkdir(sharepointRoot(ctx), { recursive: true });
  if (!existsSync(maestroPath(ctx))) await copyFile(fixtureMaestroPath(ctx), maestroPath(ctx));
}

export async function readMaestro(ctx: ToolCtx): Promise<MaestroRow[]> {
  await ensureOutDirs(ctx);
  return parseCsv(await readFile(maestroPath(ctx), "utf-8"));
}

export async function writeMaestro(ctx: ToolCtx, rows: MaestroRow[]): Promise<void> {
  await ensureOutDirs(ctx);
  await writeFile(maestroPath(ctx), maestroToCsv(rows), "utf-8");
}

export async function listarMensajes(ctx: ToolCtx): Promise<string[]> {
  const dirs = await readdir(buzonRoot(ctx), { withFileTypes: true });
  return dirs.filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export async function leerCorreo(ctx: ToolCtx, mensajeId: string): Promise<Correo | null> {
  if (!/^[\w-]+$/.test(mensajeId)) return null; // evita rutas fuera del buzón
  const p = join(buzonRoot(ctx), mensajeId, "correo.json");
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf-8")) as Correo;
}

export async function leerAdjunto(ctx: ToolCtx, mensajeId: string, adjunto: string): Promise<string | null> {
  if (!/^[\w.\-]+$/.test(adjunto)) return null;
  const p = join(buzonRoot(ctx), mensajeId, adjunto);
  if (!existsSync(p)) return null;
  return readFile(p, "utf-8");
}

export async function readProcesados(ctx: ToolCtx): Promise<Procesado[]> {
  const p = procesadosPath(ctx);
  if (!existsSync(p)) return [];
  const data = JSON.parse(await readFile(p, "utf-8")) as Procesado[];
  return Array.isArray(data) ? data : [];
}

export async function markProcesado(ctx: ToolCtx, mensajeId: string, resultado: string): Promise<void> {
  const lista = (await readProcesados(ctx)).filter((p) => p.id !== mensajeId);
  lista.push({ id: mensajeId, resultado, ts: new Date().toISOString() });
  await mkdir(dirname(procesadosPath(ctx)), { recursive: true });
  await writeFile(procesadosPath(ctx), JSON.stringify(lista, null, 2), "utf-8");
}

export async function appendHistorial(
  ctx: ToolCtx,
  entry: { id_contrato: string; accion: string; cambios: Record<string, unknown>; mensaje_id: string },
): Promise<void> {
  await ensureOutDirs(ctx);
  await appendFile(historialPath(ctx), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf-8");
}

export type EntradaHistorial = { ts: string; id_contrato: string; accion: string; cambios: Record<string, unknown>; mensaje_id: string };

export async function readHistorial(ctx: ToolCtx): Promise<EntradaHistorial[]> {
  if (!existsSync(historialPath(ctx))) return [];
  const raw = await readFile(historialPath(ctx), "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EntradaHistorial);
}

/** RN7: una línea por ejecución de herramienta. */
export async function appendToolLog(ctx: ToolCtx, entry: { herramienta: string; mensaje_id?: string; ok: boolean; resumen: string }): Promise<void> {
  await mkdir(dirname(logPath(ctx)), { recursive: true });
  await appendFile(logPath(ctx), `${JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, ...entry })}\n`, "utf-8");
}

export async function resolverComercial(ctx: ToolCtx, email: string): Promise<{ nombre: string; conocido: boolean }> {
  const lista = JSON.parse(await readFile(comercialesPath(ctx), "utf-8")) as { email: string; nombre: string }[];
  const hit = lista.find((x) => x.email.toLowerCase() === email.toLowerCase());
  return hit ? { nombre: hit.nombre, conocido: true } : { nombre: email, conocido: false };
}

const SUFIJOS_SOCIETARIOS = /\b(s\s*a\s*s|s\s*a\s*c|s\s*a|s\s+de\s+r\s*l|ltda|e\s*u)\b\.?/gi;

/** "Industrias Delta S.A.S." → "industrias-delta" (igual que las carpetas existentes del maestro). */
export function slugCliente(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\./g, " ")
    .replace(SUFIJOS_SOCIETARIOS, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Copia el adjunto a out/sharepoint/Contratos/<año>/<cliente-slug>/<nombre>.<ext> y devuelve la ruta relativa. */
export async function archivarDocumento(
  ctx: ToolCtx,
  mensajeId: string,
  adjunto: string,
  anio: string,
  cliente: string,
  nombreArchivo: string,
): Promise<string> {
  const ext = adjunto.split(".").pop() ?? "txt";
  const rel = ["Contratos", anio, slugCliente(cliente), `${nombreArchivo}.${ext}`].join("/");
  const abs = join(sharepointRoot(ctx), rel);
  await mkdir(dirname(abs), { recursive: true });
  await copyFile(join(buzonRoot(ctx), mensajeId, adjunto), abs);
  return rel;
}
