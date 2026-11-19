import { createRequire } from "node:module";
import path from "node:path";

import { default_native_path_policy } from "./native-path";

/**
 * Mantém um handle que impede a exclusão do diretório de lock no Windows.
 * Em outras plataformas, ou se o addon não puder ser carregado, não há guard:
 * a segurança passa a depender apenas da localização em userdata/temp.
 */
export interface FileLockGuard {
  close(): void;
}

type NativeFileLockAddon = Readonly<{
  hold_no_delete(path: string): number;
  release_no_delete(token: number): void;
}>;

let cached_addon: NativeFileLockAddon | null | undefined;
const require_from_here = createRequire(import.meta.url);

function addon_candidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    "build/dist-electron/native/file_lock.node",
    "build/dev/dist-electron/native/file_lock.node",
    "native/file-lock/build/Release/file_lock.node",
  ];
  if (resources !== undefined) {
    candidates.unshift(
      path.join(resources, "app.asar.unpacked", "build", "dist-electron", "native", "file_lock.node"),
    );
  }
  return candidates.map((candidate) =>
    path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate),
  );
}

function load_addon(): NativeFileLockAddon | null {
  if (cached_addon !== undefined) return cached_addon;
  if (process.platform !== "win32") {
    cached_addon = null;
    return cached_addon;
  }
  for (const candidate of addon_candidates()) {
    try {
      const loaded = require_from_here(candidate) as Partial<NativeFileLockAddon>;
      if (
        typeof loaded.hold_no_delete === "function" &&
        typeof loaded.release_no_delete === "function"
      ) {
        cached_addon = loaded as NativeFileLockAddon;
        return cached_addon;
      }
    } catch {
      // Um candidato ausente ou incompatível não impede tentar o próximo.
    }
  }
  cached_addon = null;
  return cached_addon;
}

/** Retorna null quando não há bloqueio nativo disponível; nunca lança para o chamador. */
export function acquire_no_delete_guard(lock_directory: string): FileLockGuard | null {
  const addon = load_addon();
  if (addon === null) return null;
  try {
    // Windows 长路径需要 namespaced 形态，和其余原生 IO 共用同一策略。
    const token = addon.hold_no_delete(default_native_path_policy.to_native_path(lock_directory));
    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        addon.release_no_delete(token);
      },
    };
  } catch {
    // Diretório já removido ou handle indisponível: segue sem guard.
    return null;
  }
}
