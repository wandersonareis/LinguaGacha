import { read_json_record } from "../../domain/json";
import { AppError, type LogError } from "../../shared/error";
import { collect_api_keys } from "../llm/llm-request";
import { create_provider_error } from "../network/provider-error";
import type { LLMRequestFacts } from "../llm/llm-types";
import type { JsonValue } from "../../domain/json";
import type { BatchTaskRequestRecovery, BatchTaskRequestState } from "../../domain/batch-task";
import {
  AUTO_CONCURRENCY_MIN,
  AUTO_CONCURRENCY_MAX,
  resolve_request_limits,
  type RequestRate,
} from "./request-rate";

/** 恢复请求的完整节奏：首包等待和下一次派发都以这个周期为准。 */
export const RETRY_CYCLE_MS = 60_000;
/** 恢复派发的单次尝试总时限：模型生成耗时较长时不能被恢复周期截断。 */
export const RETRY_ATTEMPT_TIMEOUT_MS = 600_000;
/** 连续没有 HTTP 响应的请求达到该次数后结束任务，任一响应会清零。 */
export const RETRY_LIMIT = 10;
const HTTP_TOO_MANY_REQUESTS = 429;

/** 一次物理派发携带的恢复事实，首次派发不覆盖任务自身的生成时限。 */
export interface DispatchAttempt {
  timeout_ms: number | null;
}

interface RequestKey {
  value: string;
  in_flight: number; // 本密钥的请求全部结束后才能进入冷却。
  state: "ready" | "draining" | "cooling" | "probing"; // 区分正常并发与单次恢复派发。
  available_at: number; // 0 表示未定时，429 在收束期记录最晚恢复时间，其余故障在收束后定时。
  last_attempt_started_at: number; // 以派发时刻计算完整的恢复周期，避免瞬时错误立即重试。
  failed: boolean; // 本轮收束中是否仍有失败；同波成功可释放密钥，不必冷却。
}

interface PendingRequest<Input, Result extends LLMRequestFacts> {
  body: Input;
  signal: AbortSignal;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  usage: {
    input_tokens: number;
    reasoning_tokens: number;
    output_tokens: number;
    usage_complete: boolean;
  }; // 随逻辑请求跨密钥累计。
  failures: number; // 连续没有取得 HTTP 响应的失败次数，任一响应清零。
  retrying: boolean; // 逻辑请求已经失败过，后续派发沿用恢复节奏。
}

interface SchedulerOptions<Input, Result extends LLMRequestFacts> {
  model: JsonValue;
  dispatch: (
    input: Input,
    key: string,
    signal: AbortSignal,
    attempt: DispatchAttempt,
  ) => Promise<Result>;
  fail_batch?: (result: Result) => boolean; // 不可恢复的单项错误可交还业务层，缺省保持整批终止。
  on_attempt?: (result: Result) => void; // 每次物理回执只结算一次，包含重试和终止前的已知用量。
  rate: RequestRate;
  on_state: (state: BatchTaskRequestState) => void; // 同步写入运行态，异步发布错误由 Runtime 完成链收束。
  on_failure: (key_index: number, error: LogError) => void;
  timeout_error: () => LogError; // 无请求错误对象的超时仍需按当前界面语言记录。
  retry_exhausted_message: (attempts: number) => string; // 连续无响应达到上限后的终止原因。
}

/** 本轮唯一请求队列；每次真实派发才匹配密钥，同时取得并发与速率资格。 */
export class RequestScheduler<Input, Result extends LLMRequestFacts> {
  private terminal_error: unknown = null; // 终止错误立即关闭派发，等待调用者完成已有流水线收尾。
  private readonly keys: RequestKey[];
  private readonly queue: PendingRequest<Input, Result>[] = [];
  private readonly active = new Set<PendingRequest<Input, Result>>(); // 已派发但尚未结算的逻辑请求。
  private offset = 0; // 下次轮换扫描密钥的起点。
  private in_flight = 0; // 全模型实际并发；密钥内计数另用于故障收束。
  private readonly auto_concurrency: boolean; // 本轮配置快照决定是否允许升降档。
  private concurrency_limit: number; // 本轮唯一并发额度，流水线只读取。
  private concurrency_version = 0; // 每次有效 429 更新，隔离降档前的成功与同波故障。
  private timer: ReturnType<typeof setTimeout> | null = null; // 速率等待与密钥冷却共用一个唤醒点。

  /** 每轮按唯一密钥建立恢复状态；速率时钟由外部跨轮复用。 */
  public constructor(private readonly options: SchedulerOptions<Input, Result>) {
    const model = read_json_record(options.model);
    const limits = resolve_request_limits(model);
    this.auto_concurrency = limits.auto_concurrency;
    this.concurrency_limit = limits.concurrency_limit;
    options.rate.set_rps_limit(this.concurrency_limit);
    this.keys = [
      ...new Set(
        model["auth_type"] === "oauth" ? [""] : collect_api_keys(String(model["api_key"] ?? "")),
      ),
    ].map((value) => ({
      value,
      in_flight: 0,
      state: "ready",
      available_at: 0,
      last_attempt_started_at: 0,
      failed: false,
    }));
  }

  /** 流水线据此供应 work unit，额度只由请求完成路径修改。 */
  public read_concurrency_limit(): number {
    return this.concurrency_limit;
  }

  /** 一个 Promise 对应一个逻辑请求，换密钥重试仍留在本轮队列。 */
  public request(body: Input, signal: AbortSignal): Promise<Result> {
    if (this.terminal_error !== null) return Promise.reject(this.terminal_error);
    if (signal.aborted) return Promise.reject(new AppError("runtime.cancelled"));
    return new Promise((resolve, reject) => {
      const pending: PendingRequest<Input, Result> = {
        body,
        signal,
        resolve,
        reject,
        usage: { input_tokens: 0, reasoning_tokens: 0, output_tokens: 0, usage_complete: true },
        failures: 0,
        retrying: false,
        abort: () => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return; // 已派发请求由真实客户端的 signal 收束。
          this.queue.splice(index, 1);
          signal.removeEventListener("abort", pending.abort);
          reject(new AppError("runtime.cancelled"));
          this.dispatch();
        },
      };
      signal.addEventListener("abort", pending.abort, { once: true });
      this.queue.push(pending);
      this.dispatch();
    });
  }

  /** 状态变化统一重算下一次唤醒；冷却中的密钥不预留任何批次或并发槽。 */
  private dispatch(): void {
    this.dispatch_pending();
    this.options.on_state(
      Object.freeze({
        request_in_flight_count: this.in_flight,
        request_concurrency_limit: this.concurrency_limit,
        request_recovery: this.read_recovery(),
      }),
    );
  }

  /** 真实派发与等待共用同一组资格，恢复截止时间也从这里读取。 */
  private dispatch_pending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.terminal_error !== null) {
      for (const pending of this.queue.splice(0)) {
        pending.signal.removeEventListener("abort", pending.abort);
        pending.reject(this.terminal_error);
      }
      return;
    }
    while (this.queue.length > 0 && this.in_flight < this.concurrency_limit) {
      // 同一个 signal 的 abort 监听依次执行；前一个监听重新派发时，后续请求也已取消。
      const head = this.queue[0]!;
      if (head.signal.aborted) {
        this.queue.shift();
        head.signal.removeEventListener("abort", head.abort);
        head.reject(new AppError("runtime.cancelled"));
        continue;
      }
      const now = Date.now();
      const key_index = this.find_available_key(now);
      const rate_delay = this.options.rate.get_dispatch_permit_delay_ms();
      if (key_index < 0 || rate_delay > 0) {
        const delay = this.read_dispatch_delay(now);
        // 没有冷却截止时间时，等待在途请求完成触发派发。
        if (Number.isFinite(delay))
          this.timer = setTimeout(() => this.dispatch(), Math.ceil(delay));
        return;
      }
      const pending = this.queue.shift()!;
      const key = this.keys[key_index]!;
      this.offset = (key_index + 1) % this.keys.length;
      if (key.state === "cooling") {
        key.state = "probing";
        key.available_at = 0;
      }
      key.last_attempt_started_at = now;
      key.in_flight += 1;
      this.in_flight += 1;
      this.active.add(pending);
      this.options.rate.consume_dispatch_permit(now);
      void this.execute(pending, key, key_index, {
        timeout_ms: pending.retrying ? RETRY_ATTEMPT_TIMEOUT_MS : null,
      });
    }
  }

  /** 冷却和速率共同决定下一次派发，收束中的密钥依靠请求完成唤醒。 */
  private read_dispatch_delay(now: number): number {
    const key_delay =
      this.find_available_key(now) >= 0
        ? 0
        : Math.min(
            ...this.keys
              .filter((key) => key.state === "cooling")
              .map((key) => Math.max(0, key.available_at - now)),
          );
    return Math.max(key_delay, this.options.rate.get_dispatch_permit_delay_ms());
  }

  /** 页面只读取恢复事实；正常并发占满和独立速率等待不构成密钥故障。 */
  private read_recovery(): BatchTaskRequestRecovery | null {
    if (this.terminal_error !== null) return null; // 终止后只等待在途请求收尾。
    // draining 密钥仍有普通请求在途，其结算优先于其他密钥的探测提示。
    if (this.keys.some((key) => key.state === "ready" || key.state === "draining")) return null;
    const retry_count = this.read_retry_count();
    if (this.keys.some((key) => key.state === "probing"))
      return Object.freeze({
        phase: "retrying",
        retry_count,
        retry_limit: RETRY_LIMIT,
        attempt_timeout_seconds: RETRY_ATTEMPT_TIMEOUT_MS / 1_000,
      });
    if (this.queue.length === 0) return null; // 全部密钥冷却且没有待派发请求。
    const now = Date.now();
    return Object.freeze({
      phase: "waiting",
      retry_count,
      retry_limit: RETRY_LIMIT,
      retry_at: now + Math.ceil(this.read_dispatch_delay(now)),
    });
  }

  /** 当前逻辑请求中最高的连续无响应次数，恢复提示只展示这个事实。 */
  private read_retry_count(): number {
    let count = 0;
    for (const pending of this.queue) count = Math.max(count, pending.failures);
    for (const pending of this.active) count = Math.max(count, pending.failures);
    return count;
  }

  /** 轮换扫描当前可用密钥，冷却结束的密钥仅取得一次恢复资格。 */
  private find_available_key(now: number): number {
    for (let step = 0; step < this.keys.length; step += 1) {
      const index = (this.offset + step) % this.keys.length;
      const key = this.keys[index]!;
      if (key.state === "ready" || (key.state === "cooling" && key.available_at <= now))
        return index;
    }
    return -1;
  }

  /** 结算真实请求并调整额度，释放在途计数后重新派发或交付结果。 */
  private async execute(
    pending: PendingRequest<Input, Result>,
    key: RequestKey,
    key_index: number,
    attempt: DispatchAttempt,
  ): Promise<void> {
    const version = this.concurrency_version; // 每次真实尝试独立取版本，换密钥重试也重新取值。
    let outcome: { result: Result } | { error: unknown } | null = null; // null 表示等待重新派发。
    try {
      const result = await this.options.dispatch(pending.body, key.value, pending.signal, attempt);
      this.options.on_attempt?.(result);
      pending.usage.usage_complete &&= result.usage_complete === true;
      for (const field of ["input_tokens", "reasoning_tokens", "output_tokens"] as const)
        pending.usage[field] += result[field];
      if (pending.signal.aborted || result.cancelled) {
        outcome = { result: { ...result, ...pending.usage, cancelled: true } };
        if (key.state === "probing") {
          key.state = "cooling";
          key.available_at = Date.now();
        }
      } else if (result.timeout || result.request_error !== undefined) {
        const failure = result.request_error ?? this.options.timeout_error();
        this.options.on_failure(key_index, failure);
        // 没有取得 HTTP 响应才计入连续失败；429/5xx 等响应会清零，避免把限流当成断线。
        const no_response =
          result.timeout === true ||
          (result.request_error !== undefined && result.http_status === undefined);
        pending.failures = no_response ? pending.failures + 1 : 0;
        pending.retrying = true;
        if (result.retryable === false) {
          if (this.options.fail_batch?.(result) === false) {
            // 单项载荷错误证明接口仍可响应，恢复探测必须释放密钥供下一项使用。
            key.failed = false;
            key.available_at = 0;
            if (key.state !== "draining") key.state = "ready";
            outcome = { result: { ...result, ...pending.usage } };
            return;
          }
          throw create_provider_error(failure.message, result.http_status, {
            retryable: false,
            failure,
          });
        }
        if (pending.failures >= RETRY_LIMIT) {
          throw create_provider_error(
            this.options.retry_exhausted_message(pending.failures),
            undefined,
            { retryable: false, failure },
          );
        }
        if (result.http_status === HTTP_TOO_MANY_REQUESTS) {
          this.adjust_concurrency(version, false);
          const delay = Math.min(result.retry_after_ms ?? 0, RETRY_CYCLE_MS);
          key.available_at = Math.max(
            key.available_at,
            (result.http_received_at ?? Date.now()) + delay,
          );
        }
        this.fail_key(key);
      } else {
        this.adjust_concurrency(version, true);
        pending.failures = 0;
        pending.retrying = false;
        key.failed = false;
        key.available_at = 0;
        // 正常响应即恢复密钥；仍在收束的并发请求按完成顺序参与最终判断。
        if (key.state !== "draining") key.state = "ready";
        outcome = { result: { ...result, ...pending.usage } };
      }
    } catch (error) {
      this.terminal_error = error;
      // 客户端已将预期网络错误归一；抛出的异常属于基础设施错误，不能惩罚密钥。
      outcome = { error };
    } finally {
      key.in_flight -= 1;
      this.in_flight -= 1;
      this.active.delete(pending);
      if (key.in_flight === 0 && key.state === "draining") {
        if (key.failed) this.cool_key(key);
        else key.state = "ready";
      }
      if (outcome === null && !pending.signal.aborted) this.queue.push(pending);
      else {
        pending.signal.removeEventListener("abort", pending.abort);
        if (outcome === null) pending.reject(new AppError("runtime.cancelled"));
        else if ("error" in outcome) pending.reject(outcome.error);
        else pending.resolve(outcome.result);
      }
      this.dispatch();
    }
  }

  /** 版本同时约束升档和退让；旧请求仍正常参与密钥恢复与结果结算。 */
  private adjust_concurrency(version: number, success: boolean): void {
    if (!this.auto_concurrency || version !== this.concurrency_version) return;
    if (success) {
      this.concurrency_limit = Math.min(AUTO_CONCURRENCY_MAX, this.concurrency_limit + 1);
    } else {
      this.concurrency_limit = Math.max(
        AUTO_CONCURRENCY_MIN,
        Math.floor(this.concurrency_limit / 2),
      );
      this.concurrency_version += 1;
    }
    this.options.rate.set_rps_limit(this.concurrency_limit);
  }

  /** 并发故障收束为一次冷却，单个恢复请求才推进后续周期。 */
  private fail_key(key: RequestKey): void {
    key.state = "draining";
    key.failed = true;
  }

  /** 收束后统一开始退避，完整恢复周期从本次尝试的派发时刻起算。 */
  private cool_key(key: RequestKey): void {
    key.state = "cooling";
    key.available_at = Math.max(key.available_at, key.last_attempt_started_at + RETRY_CYCLE_MS);
  }
}
