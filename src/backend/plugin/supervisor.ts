import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { default_native_fs, type NativeFs } from "../../native/native-fs";
import {
  AppError,
  is_app_error,
  is_app_error_code,
  read_error_message,
} from "../../shared/error";
import {
  PLUGIN_API_VERSION,
  read_plugin_detect_result,
  read_plugin_host_response,
  read_plugin_host_signal,
  read_plugin_read_result,
  read_plugin_write_result,
  type PluginHostFailure,
  type PluginHostRequest,
  type PluginHostResponse,
  type PluginHostResult,
  type PluginItem,
  type PluginManifest,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 15_000;
const EXIT_WAIT_MS = 2_000;
// 插件只接收运行必需的宿主变量；网关令牌、代理与模型密钥不得进入子进程。
const ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "ComSpec",
  "PATHEXT",
] as const;

export type PluginWriteFiles = Readonly<{ translated?: Uint8Array; bilingual?: Uint8Array }>;

export type PluginSupervisorOptions = Readonly<{
  manifest: PluginManifest;
  entry_path: string; // 插件 ESM 入口
  host_entry: string; // 已构建的宿主入口，由 Node 直接执行
  node_executable: string; // Node 或 Electron 可执行文件
  node_arguments?: readonly string[]; // 额外 Node 参数（权限、内存等）
  node_env?: Readonly<Record<string, string>>;
  target_language: string;
  timeout_ms?: number;
  hardening?: boolean; // 启用权限模型与堆上限；默认关闭以兼容旧宿主
  native_fs?: NativeFs;
  log?: (line: string) => void;
}>;

type Pending = {
  resolve: (response: PluginHostResponse) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  method: PluginHostRequest["method"];
};

/**
 * 每个插件由一个独立子进程承载，失败只影响当前调用。
 * 父进程只传递路径与元数据；正文经工作目录落盘，避免大文件走序列化。
 */
export class PluginSupervisor {
  private readonly native_fs: NativeFs;
  private readonly timeout_ms: number;
  private readonly pending = new Map<number, Pending>();
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private work_root: string | null = null;
  private next_id = 1;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: PluginSupervisorOptions) {
    this.native_fs = options.native_fs ?? default_native_fs;
    this.timeout_ms = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  /** 解析来源文件；返回的条目已按清单与条目形状校验。 */
  public async read(
    rel_path: string,
    content: Uint8Array,
  ): Promise<Readonly<{ file_type: string; items: readonly PluginItem[] }>> {
    return await this.invoke(
      async (id, directory) => {
        const input_path = path.join(directory, "input.bin");
        await this.native_fs.write_file(input_path, content);
        return {
          v: PLUGIN_API_VERSION,
          id,
          method: "read",
          params: { rel_path, input_path },
        };
      },
      (result) => read_plugin_read_result(result, this.options.manifest.file_types),
    );
  }

  /** 写回插件产物；返回字节由核心按原工程路径落盘。 */
  public async write(
    rel_path: string,
    items: readonly PluginItem[],
    asset: Uint8Array,
  ): Promise<PluginWriteFiles> {
    return await this.invoke(
      async (id, directory) => {
        const asset_path = path.join(directory, "asset.bin");
        await this.native_fs.write_file(asset_path, asset);
        return {
          v: PLUGIN_API_VERSION,
          id,
          method: "write",
          params: {
            rel_path,
            items,
            asset_path,
            translated_path: path.join(directory, "translated.out"),
            bilingual_path: path.join(directory, "bilingual.out"),
          },
        };
      },
      (result, directory) => {
        const written = read_plugin_write_result(result);
        const files: { translated?: Uint8Array; bilingual?: Uint8Array } = {};
        if (written.written.includes("translated")) {
          files.translated = this.native_fs.read_file(path.join(directory, "translated.out"));
        }
        if (written.written.includes("bilingual")) {
          files.bilingual = this.native_fs.read_file(path.join(directory, "bilingual.out"));
        }
        return files;
      },
    );
  }

  /** 内容识别只回答是否命中，不产生条目。 */
  public async detect(rel_path: string, content: Uint8Array): Promise<boolean> {
    return await this.invoke(
      async (id, directory) => {
        const input_path = path.join(directory, "input.bin");
        await this.native_fs.write_file(input_path, content);
        return {
          v: PLUGIN_API_VERSION,
          id,
          method: "detect",
          params: { rel_path, input_path },
        };
      },
      (result) => read_plugin_detect_result(result).detected,
    );
  }

  /** 关闭子进程并清理工作根；之后的调用统一报告已释放。 */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.kill(new AppError("runtime.disposed"));
    if (child !== null) await wait_for_exit(child, EXIT_WAIT_MS);
    await this.queue.catch(() => undefined);
    if (this.work_root !== null) {
      const work_root = this.work_root;
      this.work_root = null;
      await this.native_fs.remove_async(work_root, { recursive: true, force: true }).catch(() => {
        // 临时工作根残留只会占用磁盘，不能覆盖已完成的关闭语义。
      });
    }
  }

  private async invoke<T>(
    build: (id: number, directory: string) => Promise<PluginHostRequest>,
    consume: (result: PluginHostResult, directory: string) => T,
  ): Promise<T> {
    return await this.enqueue(async () => {
      if (this.disposed) throw new AppError("runtime.disposed");
      const id = this.next_id++;
      const directory = path.join(await this.ensure_work_root(), String(id));
      await this.native_fs.make_dir_async(directory);
      try {
        const response = await this.send(await build(id, directory));
        if (!response.ok) throw to_app_error(response.error);
        return consume(response.result, directory);
      } finally {
        await this.native_fs.remove_async(directory, { recursive: true, force: true }).catch(() => {
          // 单次请求目录清理失败不改变结果；下一次请求使用新目录。
        });
      }
    });
  }

  private async send(request: PluginHostRequest): Promise<PluginHostResponse> {
    const child = await this.ensure_child();
    return await new Promise<PluginHostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const error = new AppError("runtime.cancelled", { message: "Plugin call timed out." });
        const child = this.kill(error);
        void wait_for_exit(child, EXIT_WAIT_MS).finally(() => reject(error));
      }, this.timeout_ms);
      this.pending.set(request.id, { resolve, reject, timer, method: request.method });
      child.send(request, (error) => {
        if (error === null) return;
        this.pending.delete(request.id);
        clearTimeout(timer);
        reject(new AppError("file.io_failed", { cause: error }));
      });
    });
  }

  /** 只结算仍在等待的同 ID 响应；信号消息由 ready/fatal 处理。 */
  private accept(message: unknown): void {
    let response: PluginHostResponse;
    try {
      response = read_plugin_host_response(message);
    } catch {
      return; // ready/fatal 等信号不是响应；形状错误由调用方超时兜底。
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private async ensure_child(): Promise<ChildProcess> {
    if (this.disposed) throw new AppError("runtime.disposed");
    if (this.child !== null) return this.child;
    if (this.starting === null) {
      this.starting = this.start_child().finally(() => {
        this.starting = null;
      });
    }
    return await this.starting;
  }

  private async start_child(): Promise<ChildProcess> {
    const work_root = await this.ensure_work_root();
    const launch_options: ForkOptions & { windowsHide: boolean } = {
      execPath: this.options.node_executable,
      execArgv: [
        ...(this.options.node_arguments ?? []),
        ...(this.options.hardening === true
          ? [
              "--permission", // 只放行宿主与插件所需路径；网络仍由外层环境约束
              `--allow-fs-read=${to_child_path(this.options.host_entry)}`,
              `--allow-fs-read=${to_child_path(path.dirname(this.options.entry_path))}`,
              `--allow-fs-read=${work_root}`,
              `--allow-fs-write=${work_root}`,
              "--max-old-space-size=256",
            ]
          : []),
      ],
      cwd: to_child_path(path.dirname(this.options.entry_path)),
      env: this.build_env(work_root),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // 只传元数据与路径；V8 序列化在跨 Node 版本时不可靠，保持默认 JSON 通道。
      windowsHide: true,
    };
    const child = fork(this.options.host_entry, [], launch_options);
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.options.log?.(chunk));
    child.stderr?.on("data", (chunk: string) => this.options.log?.(chunk));
    child.on("message", (message: unknown) => this.accept(message));
    child.on("exit", (code, signal) => this.handle_exit(child, code, signal));
    child.on("error", (error) => this.handle_exit(child, null, null, error));
    try {
      await this.wait_ready(child);
    } catch (error) {
      const failure = is_app_error(error)
        ? error
        : new AppError("runtime.internal_invariant", { cause: error });
      this.kill(failure);
      throw failure;
    }
    return child;
  }

  private async wait_ready(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        child.off("message", on_message);
        child.off("exit", on_exit);
      };
      const on_message = (message: unknown): void => {
        const signal = read_plugin_host_signal(message);
        if (signal === null) return;
        finish();
        if (signal.type === "ready") resolve();
        else reject(to_app_error(signal.error));
      };
      const on_exit = (): void => {
        finish();
        reject(new AppError("runtime.cancelled", { message: "Plugin host exited before ready." }));
      };
      timer = setTimeout(() => {
        finish();
        reject(new AppError("runtime.cancelled", { message: "Plugin host did not become ready." }));
      }, START_TIMEOUT_MS);
      child.on("message", on_message);
      child.on("exit", on_exit);
    });
  }

  private handle_exit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    const detail =
      error === undefined
        ? `Plugin host exited (code=${String(code)}, signal=${String(signal)}).`
        : `Plugin host failed: ${read_error_message(error)}`;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new AppError(pending.method === "write" ? "file.io_failed" : "file.parse_failed", {
          message: detail,
          cause: error,
        }),
      );
    }
  }

  private kill(error: AppError): ChildProcess | null {
    const child = this.child;
    this.child = null;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    child?.kill("SIGKILL");
    return child;
  }

  private async ensure_work_root(): Promise<string> {
    if (this.work_root === null) {
      // 绝对前缀确保子进程 cwd 不同也能解析同一路径；权限模型按绝对路径放行。
      this.work_root = to_child_path(
        await this.native_fs.make_temp_dir(path.join(os.tmpdir(), "lg-plugin-")),
      );
    }
    return this.work_root;
  }

  private build_env(work_root: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.options.node_env);
    env["LG_PLUGIN_MANIFEST"] = JSON.stringify(this.options.manifest);
    env["LG_PLUGIN_ENTRY"] = this.options.entry_path;
    env["LG_PLUGIN_WORK_ROOT"] = work_root;
    env["LG_PLUGIN_TARGET_LANGUAGE"] = this.options.target_language;
    return env;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function to_app_error(failure: PluginHostFailure): AppError {
  return new AppError(is_app_error_code(failure.code) ? failure.code : "file.parse_failed", {
    message: failure.message,
  });
}

/** Windows 扩展长度前缀只用于本进程 IO；传给子进程与权限模型时使用普通路径。 */
function to_child_path(value: string): string {
  return process.platform === "win32" && value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

/** 等待子进程真正退出，避免 Windows 上工作目录仍被占用。 */
async function wait_for_exit(child: ChildProcess | null, timeout_ms: number): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    timer = setTimeout(finish, timeout_ms);
    child.on("exit", finish);
  });
}
