/**
 * Genera modulo/ (bonus 9.4) a partir de las mismas fuentes que usa la app:
 *   agent/prompt.md                    → modulo/agent.md (con frontmatter)
 *   src/knowledge/registro-contratos.md → modulo/skill/registro-contratos/SKILL.md (con frontmatter)
 *   src/tools/contratos.ts             → modulo/tools/contratos.ts (re-export, no copia)
 * `verificarModulo` comprueba que no haya divergencias (lo corre demo.ts).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const AGENT_FM = `---
description: Registra contratos vigentes desde el buzón único de Periferia, pide confirmación humana para campos dudosos y genera alertas de vencimiento y pólizas.
mode: primary
permission:
  edit: deny
  bash: deny
---

`;

const SKILL_FM = `---
name: registro-contratos
description: Reglas del proceso de registro de contratos vigentes de Periferia (clasificación, confianza, pólizas, archivo y alertas). Úsala al procesar el buzón de contratos.
---

`;

const TOOLS_REEXPORT = `// Mismas herramientas que usa la app: se re-exportan, no se copian.
export { leer_buzon, extraer, validar, registrar, alertas, consultar, actualizar_poliza } from "../../src/tools/contratos";
`;

async function esperados(dir: string): Promise<Record<string, string>> {
  return {
    "modulo/agent.md": AGENT_FM + (await readFile(join(dir, "agent/prompt.md"), "utf-8")),
    "modulo/skill/registro-contratos/SKILL.md": SKILL_FM + (await readFile(join(dir, "src/knowledge/registro-contratos.md"), "utf-8")),
    "modulo/tools/contratos.ts": TOOLS_REEXPORT,
  };
}

export async function construirModulo(dir: string): Promise<void> {
  for (const [rel, contenido] of Object.entries(await esperados(dir))) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contenido, "utf-8");
  }
}

export async function verificarModulo(dir: string): Promise<boolean> {
  for (const [rel, contenido] of Object.entries(await esperados(dir))) {
    const abs = join(dir, rel);
    if (!existsSync(abs) || (await readFile(abs, "utf-8")) !== contenido) return false;
  }
  return true;
}

if (import.meta.main) {
  const dir = join(import.meta.dir, "..");
  await construirModulo(dir);
  console.log("modulo/ generado desde agent/prompt.md, src/knowledge/ y src/tools/");
}
