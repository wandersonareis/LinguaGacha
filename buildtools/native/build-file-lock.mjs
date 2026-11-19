import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const module_dir = path.join(root, "native", "file-lock");
const addon_path = path.join(module_dir, "build", "Release", "file_lock.node");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const electron_version = manifest.devDependencies.electron.replace(/^[^\d]*/, "");

// O addon roda dentro do Electron, não do Node CLI: compilar contra os headers
// do Electron é obrigatório para o módulo carregar em dev e no pacote final.
const node_gyp = path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
const result = spawnSync(
  process.execPath,
  [
    node_gyp,
    "rebuild",
    "--directory",
    module_dir,
    "--target",
    electron_version,
    "--dist-url",
    "https://electronjs.org/headers",
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);

if (result.status !== 0) {
  // Sem Visual C++ Build Tools o guard de exclusão fica inativo; o app continua
  // seguro o bastante porque as locks ficam em userdata/temp e a deleção só
  // produz um aviso. Uma falha aqui não deve impedir o build do resto do app.
  if (process.env.LG_REQUIRE_NATIVE_LOCK === "1") {
    console.error("[file-lock] build nativo obrigatório falhou.");
    process.exit(result.status ?? 1);
  }
  console.warn("[file-lock] build nativo indisponível; seguindo sem proteção contra exclusão.");
  process.exit(0);
}

// electron-vite limpa dist-electron, então a cópia deve acontecer depois dele.
const packaged_dir = path.join(root, "build", "dist-electron", "native");
fs.mkdirSync(packaged_dir, { recursive: true });
fs.copyFileSync(addon_path, path.join(packaged_dir, "file_lock.node"));
