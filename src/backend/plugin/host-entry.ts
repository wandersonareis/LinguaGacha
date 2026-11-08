import { AppError, is_app_error, read_error_message } from "../../shared/error";
import { PluginHost } from "./host";
import {
  PLUGIN_API_VERSION,
  read_plugin_host_request,
  read_plugin_manifest,
  type PluginHostFailure,
} from "./protocol";

/** 子进程入口由宿主 fork；路径与清单只经环境变量传入。 */
if (process.send === undefined) {
  process.stderr.write("Plugin host requires an IPC channel.\n");
  process.exit(1);
}

try {
  const manifest = read_plugin_manifest(
    JSON.parse(process.env["LG_PLUGIN_MANIFEST"] ?? "null") as unknown,
  );
  const host = new PluginHost({
    manifest,
    entry_path: read_env("LG_PLUGIN_ENTRY"),
    work_root: read_env("LG_PLUGIN_WORK_ROOT"),
    target_language: process.env["LG_PLUGIN_TARGET_LANGUAGE"] ?? "",
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await host.start();
  process.send!({ v: PLUGIN_API_VERSION, type: "ready", api_version: PLUGIN_API_VERSION });
  process.on("message", (message: unknown) => {
    void (async () => {
      let request;
      try {
        request = read_plugin_host_request(message);
      } catch {
        // 请求形状错误属于父进程缺陷；保持通道可用，由父进程超时结算。
        return;
      }
      process.send!(await host.handle(request));
    })();
  });
  process.on("disconnect", () => process.exit(0));
} catch (error) {
  const failure: PluginHostFailure = is_app_error(error)
    ? { code: error.code, message: error.message }
    : { code: "runtime.internal_invariant", message: read_error_message(error) };
  process.send!({ v: PLUGIN_API_VERSION, type: "fatal", error: failure }, () => process.exit(1));
}

function read_env(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new AppError("request.validation_failed", {
      diagnostic_context: { reason: "plugin_host_env_missing", key },
    });
  }
  return value;
}
