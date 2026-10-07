import { join } from "node:path";

export type ToolCtx = { directory: string; sessionId: string };

export function fixtureRoot(ctx: ToolCtx): string {
  return join(ctx.directory, "fixtures", "reto-02");
}

export function outRoot(ctx: ToolCtx): string {
  return join(ctx.directory, "out");
}

export function sharepointRoot(ctx: ToolCtx): string {
  return join(outRoot(ctx), "sharepoint");
}

export function maestroPath(ctx: ToolCtx): string {
  return join(sharepointRoot(ctx), "maestro-contratos.csv");
}

export function fixtureMaestroPath(ctx: ToolCtx): string {
  return join(fixtureRoot(ctx), "maestro-contratos.csv");
}

export function buzonRoot(ctx: ToolCtx): string {
  return join(fixtureRoot(ctx), "buzon");
}

export function procesadosPath(ctx: ToolCtx): string {
  return join(outRoot(ctx), "procesados.json");
}

export function historialPath(ctx: ToolCtx): string {
  return join(sharepointRoot(ctx), "historial.jsonl");
}

export function logPath(ctx: ToolCtx): string {
  return join(outRoot(ctx), "log.jsonl");
}

export function alertasPath(ctx: ToolCtx): string {
  return join(outRoot(ctx), "alertas.md");
}

export function comercialesPath(ctx: ToolCtx): string {
  return join(fixtureRoot(ctx), "comerciales.json");
}

export function acusesRoot(ctx: ToolCtx): string {
  return join(outRoot(ctx), "acuses");
}
