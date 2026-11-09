import lockfile from "proper-lockfile";
import { default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

/**
 * GUI 运行期按数据根独占，避免两个实例争用同一 userdata。
 *
 * CLI 与 GUI 共用后端，但 CLI 需要与 GUI 并行，因此锁只由 GUI 组合根持有。
 */
export class AppInstanceLock {
  private released = false;

  private constructor(private readonly release_lock: () => Promise<void>) {}

  /** 目录缺失时由首次启动创建，锁产物由 proper-lockfile 放在同级。 */
  public static async acquire(user_data_root: string): Promise<AppInstanceLock> {
    try {
      default_native_fs.make_dir(user_data_root);
      const release = await lockfile.lock(user_data_root, { retries: 0 });
      return new AppInstanceLock(release);
    } catch (error) {
      if (is_lock_conflict(error)) {
        throw new AppError("runtime.instance_in_use", {
          diagnostic_context: { operation: "acquire_instance_lock" },
        });
      }
      throw new AppError("file.io_failed", {
        cause: error,
        diagnostic_context: { operation: "acquire_instance_lock" },
      });
    }
  }

  /** 关闭流程最后释放，确保目录恢复和资源收尾完成前不会出现第二个实例。 */
  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.release_lock();
  }
}

/** proper-lockfile 用 ELOCKED 表达目标已被其它进程持有。 */
function is_lock_conflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED";
}
