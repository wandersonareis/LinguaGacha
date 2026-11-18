import type { BatchTaskRequestState } from "../../domain/batch-task";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log_error_from_message } from "../../shared/error";
import type { LLMClientPort, LLMRequestBody, LLMRequestResult } from "../llm/llm-types";
import { RequestRatePool } from "./request-rate";
import { RequestScheduler } from "./request-scheduler";

// 错误文案刻意不含状态码，调度器必须消费结构化 HTTP 事实。
const failure = () => response({ http_status: 429, request_error: log_error_from_message("限流") });
const timeout_error = () => log_error_from_message("请求超时");
const retry_exhausted_message = (attempts: number) => `连续无响应 ${attempts} 次`;

describe("RequestScheduler", () => {
  it("不可重试错误立即拒绝排队批次并停止新派发", async () => {
    const first = deferred();
    const request = vi.fn<LLMClientPort["request"]>().mockReturnValue(first.promise);
    const { scheduler, failures } = setup(request, "key", { concurrency_limit: 1, rpm_limit: 0 });
    const signal = new AbortController().signal;
    const results = [
      scheduler.request(body("one"), signal),
      scheduler.request(body("two"), signal),
    ];
    const finished = Promise.allSettled(results);
    first.resolve(
      response({
        retryable: false,
        request_error: log_error_from_message("subscription_sharing_usage_limit_exceeded"),
      }),
    );
    expect((await finished).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(scheduler.request(body("three"), signal)).rejects.toMatchObject({
      code: "model.provider_failed",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(failures).toHaveBeenCalledExactlyOnceWith(
      0,
      expect.objectContaining({ message: "subscription_sharing_usage_limit_exceeded" }),
    );
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([undefined, 10_000, 90_000, 180_000])(
    "429 的 Retry-After %s 毫秒不会突破 60 秒恢复周期",
    async (retry_after_ms) => {
      const request = vi
        .fn<LLMClientPort["request"]>()
        .mockResolvedValueOnce(
          response({
            ...failure(),
            ...(retry_after_ms === undefined ? {} : { retry_after_ms }),
            http_received_at: 0,
          }),
        )
        .mockResolvedValue(response());
      const { scheduler } = setup(request);
      const result = scheduler.request(body(), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await result;
    },
  );

  it("同波 429 保留最晚服务端截止时间", async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      if (call === 1) return first.promise;
      if (call === 2) return second.promise;
      return response();
    });
    const { scheduler } = setup(request);
    const results = [1, 2].map(() => scheduler.request(body(), new AbortController().signal));
    first.resolve(response({ ...failure(), retry_after_ms: 90_000, http_received_at: 0 }));
    await vi.advanceTimersByTimeAsync(60_000);
    second.resolve(response({ ...failure(), retry_after_ms: 10_000, http_received_at: 60_000 }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(4);
    expect(Date.now()).toBe(70_000);
    await Promise.all(results);
  });

  it("原生响应跨恢复保留载荷，单项错误释放探测密钥并继续后续项", async () => {
    const model = { api_key: "native-key", threshold: { concurrency_limit: 1, rpm_limit: 0 } };
    const native_response = { id: "response", status: "completed", output: [] };
    const dispatch = vi.fn(
      async (input: { input: string }, _key: string, _signal: AbortSignal) => ({
        input_tokens: 3,
        reasoning_tokens: 0,
        output_tokens: 1,
        cancelled: false,
        timeout: false,
        response: native_response,
        ...(input.input === "bad"
          ? { retryable: false, request_error: log_error_from_message("Invalid input") }
          : {}),
      }),
    );
    dispatch.mockResolvedValueOnce({
      input_tokens: 2,
      reasoning_tokens: 0,
      output_tokens: 0,
      cancelled: false,
      timeout: true,
      response: native_response,
    });
    const on_attempt = vi.fn();
    const scheduler = new RequestScheduler({
      model,
      timeout_ms: 60_000,
      rate: new RequestRatePool().resolve(model),
      dispatch,
      fail_batch: () => false,
      on_attempt,
      on_state: vi.fn(),
      on_failure: vi.fn(),
      timeout_error,
      retry_exhausted_message,
    });
    const signal = new AbortController().signal;
    const failed = scheduler.request({ input: "bad" }, signal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await failed).toMatchObject({ input_tokens: 5, retryable: false });
    const succeeded = scheduler.request({ input: "good" }, signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await succeeded).toMatchObject({ input_tokens: 3, response: native_response });
    expect(dispatch.mock.calls.map(([input, key]) => [input.input, key])).toEqual([
      ["bad", "native-key"],
      ["bad", "native-key"],
      ["good", "native-key"],
    ]);
    expect(on_attempt).toHaveBeenCalledTimes(3);
    expect(on_attempt.mock.calls.map(([result]) => result.input_tokens)).toEqual([2, 3, 3]);
  });

  it("同配置切换请求格式仍共用速率资格", async () => {
    const model = {
      id: "shared",
      api_key: "key",
      threshold: { concurrency_limit: 1, rpm_limit: 60 },
    };
    const pool = new RequestRatePool();
    const common = {
      model,
      timeout_ms: 60_000,
      on_state: vi.fn(),
      on_failure: vi.fn(),
      timeout_error,
      retry_exhausted_message,
    };
    const text = new RequestScheduler({
      ...common,
      rate: pool.resolve(model),
      dispatch: async (_input: string) => response(),
    });
    await text.request("text", new AbortController().signal);
    const dispatch = vi.fn(async (_input: { input: string }) => ({
      input_tokens: 0,
      reasoning_tokens: 0,
      output_tokens: 0,
      cancelled: false,
      timeout: false,
      response: { status: "completed" },
    }));
    const native = new RequestScheduler({ ...common, rate: pool.resolve(model), dispatch });
    const next = native.request({ input: "native" }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toMatchObject({ response: { status: "completed" } });
  });

  // 16 是本次明确要求的并发上限，验证真实升档后的额度。
  it("双零从 4 开始，每次成功升档至 16，新任务重新探测", async () => {
    const request = vi.fn(async () => response());
    const { scheduler } = setup(request, "A", { concurrency_limit: 0, rpm_limit: 0 });
    expect(scheduler.read_concurrency_limit()).toBe(4);
    for (let count = 1; count <= 30; count += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await scheduler.request(body(), new AbortController().signal);
    }
    expect(scheduler.read_concurrency_limit()).toBe(16);
    expect(
      setup(request, "A", {
        concurrency_limit: 0,
        rpm_limit: 0,
      }).scheduler.read_concurrency_limit(),
    ).toBe(4);
  });

  it.each([
    [64, 0, 64],
    [0, 60, 60],
    [16, 60, 16],
  ])(
    "显式配置并发 %i、RPM %i 时成功和 429 都保持额度",
    async (concurrency_limit, rpm_limit, expected) => {
      let count = 0;
      const { scheduler } = setup(async () => (++count === 1 ? failure() : response()), "A", {
        concurrency_limit,
        rpm_limit,
      });
      const result = scheduler.request(body(), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.read_concurrency_limit()).toBe(expected);
      await vi.advanceTimersByTimeAsync(60_000);
      await result;
      expect(scheduler.read_concurrency_limit()).toBe(expected);
    },
  );

  it("多 Key 同波 429 只退让一次，旧成功不升档，重派请求使用新版本", async () => {
    const attempts: ReturnType<typeof deferred<LLMRequestResult>>[] = [];
    const { scheduler } = setup(
      () => {
        const attempt = deferred();
        attempts.push(attempt);
        return attempt.promise;
      },
      "A\nB\nC\nD",
      { concurrency_limit: 0, rpm_limit: 0 },
    );
    const results = [1, 2, 3, 4].map((id) =>
      scheduler.request(body(String(id)), new AbortController().signal),
    );
    expect(attempts).toHaveLength(4);
    attempts[0]!.resolve(failure());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.read_concurrency_limit()).toBe(2);
    expect(attempts).toHaveLength(4); // 在途尚未低于新额度，不能补发。
    attempts[1]!.resolve(failure());
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.read_concurrency_limit()).toBe(2);
    attempts[2]!.resolve(response());
    attempts[3]!.resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.read_concurrency_limit()).toBe(2);
    expect(attempts).toHaveLength(6);
    attempts[4]!.resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.read_concurrency_limit()).toBe(3);
    attempts[5]!.resolve(failure());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.read_concurrency_limit()).toBe(1);
    attempts[6]!.resolve(response());
    await Promise.all(results);
    expect(scheduler.read_concurrency_limit()).toBe(2);
  });

  it("非 429 网络错误和取消不调整额度，内容终态错误仍计请求成功", async () => {
    const request = vi
      .fn<LLMClientPort["request"]>()
      .mockResolvedValueOnce(response({ timeout: true }))
      .mockResolvedValueOnce(
        response({ http_status: 401, request_error: log_error_from_message("认证失败") }),
      )
      .mockResolvedValueOnce(response({ response_error: log_error_from_message("截断") }))
      .mockResolvedValueOnce(response({ cancelled: true }));
    const { scheduler } = setup(request, "A", { concurrency_limit: 0, rpm_limit: 0 });
    const result = scheduler.request(body(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.read_concurrency_limit()).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.read_concurrency_limit()).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(scheduler.read_concurrency_limit()).toBe(5);
    await scheduler.request(body(), new AbortController().signal);
    expect(scheduler.read_concurrency_limit()).toBe(5);
  });

  it("持续 429 按 60 秒周期退让至 1，冷却中取消立即结算且不再唤醒", async () => {
    const request = vi.fn(async () => failure());
    const { scheduler, state } = setup(request, "A", { concurrency_limit: 0, rpm_limit: 0 });
    const controller = new AbortController();
    const result = scheduler.request(body(), controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(scheduler.read_concurrency_limit()).toBe(1);
    expect(request).toHaveBeenCalledTimes(4);
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request_in_flight_count: 0,
        request_recovery: {
          phase: "waiting",
          retry_count: 0,
          retry_limit: 10,
          retry_at: 240_000,
        },
      }),
    );
    controller.abort();
    expect(await result).toMatchObject({ code: "runtime.cancelled" });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ request_in_flight_count: 0, request_recovery: null }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("失败批次立即转用健康 Key，冷却不占请求压力或等待原 Key", async () => {
    const calls: string[] = [];
    const run_ids: string[] = [];
    const { scheduler, state, failures } = setup(async (body) => {
      const key = (body.model as { api_key: string }).api_key;
      calls.push(key);
      run_ids.push(body.run_id);
      return key === "A" ? failure() : response();
    }, "A\nB");
    expect(await scheduler.request(body(), new AbortController().signal)).toMatchObject({
      response_result: "ok",
    });
    expect(calls).toEqual(["A", "B"]);
    expect(run_ids).toEqual(["run", "run"]);
    expect(Date.now()).toBe(0);
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ request_in_flight_count: 0, request_recovery: null }),
    );
    expect(failures).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连续 10 次无响应后终止整批，任意 HTTP 响应会重置计数", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 10) return failure();
      if (calls <= 19) return response({ timeout: true });
      return response();
    });
    const { scheduler, failures, state } = setup(request);
    const result = scheduler.request(body(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_140_000);
    expect(await result).toMatchObject({
      response_result: "ok",
    });
    expect(calls).toBe(20);
    expect(failures).toHaveBeenCalledTimes(19);
    expect(state.mock.lastCall?.[0].request_recovery).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("连续无响应达到 10 次后以终止错误结束", async () => {
    const request = vi.fn(async () => response({ timeout: true }));
    const { scheduler, failures } = setup(request);
    const result = scheduler
      .request(body(), new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(540_000);
    expect(await result).toMatchObject({
      code: "model.provider_failed",
      message: "连续无响应 10 次",
    });
    expect(request).toHaveBeenCalledTimes(10);
    expect(failures).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("按 60 秒周期恢复，成功时交付响应与累计用量", async () => {
    const started_at: number[] = [];
    const request = vi.fn(async () => {
      started_at.push(Date.now());
      return response({ timeout: started_at.length <= 4, input_tokens: 2 });
    });
    const { scheduler, state } = setup(request);
    const result = scheduler.request(body(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request_in_flight_count: 0,
        request_recovery: {
          phase: "waiting",
          retry_count: 1,
          retry_limit: 10,
          retry_at: 60_000,
        },
      }),
    );
    for (const delay of [1, 60_000, 60_000, 60_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(started_at).toEqual([0, 60_000, 120_000, 180_000, 240_000]);
    expect(await result).toMatchObject({ response_result: "ok", input_tokens: 10 });
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ request_in_flight_count: 0, request_recovery: null }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("网络恢复即重置退避与连续不可用计数，内容错误由调用者处理", async () => {
    let count = 0;
    const { scheduler, state } = setup(async () =>
      ++count % 2 === 0
        ? response({ response_error: log_error_from_message("length") })
        : failure(),
    );
    for (let run = 0; run < 2; run += 1) {
      const result = scheduler.request(body(), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.mock.lastCall?.[0].request_recovery).toMatchObject({ retry_count: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await result).toHaveProperty("response_error");
      expect(state.mock.lastCall?.[0].request_recovery).toBeNull();
    }
    expect(count).toBe(4);
  });

  it("同波并发失败后按周期只派发一个探测，探测成功恢复其余请求", async () => {
    const calls: string[] = [];
    const probe = deferred<LLMRequestResult>();
    const request = vi.fn(async (body: LLMRequestBody) => {
      calls.push(body.work_unit_id);
      if (calls.length <= 3) return failure();
      if (calls.length === 4) return probe.promise;
      return response();
    });
    const { scheduler, state } = setup(request);
    const results = [1, 2, 3].map((id) =>
      scheduler.request(body(String(id)), new AbortController().signal),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(state.mock.lastCall?.[0].request_recovery).toEqual({
      phase: "waiting",
      retry_count: 0,
      retry_limit: 10,
      retry_at: 60_000,
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(4);
    expect(state.mock.lastCall?.[0].request_recovery).toEqual({
      phase: "retrying",
      retry_count: 0,
      retry_limit: 10,
      attempt_timeout_seconds: 60,
    });
    probe.resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    expect((await Promise.all(results)).every((result) => result.response_result === "ok")).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(6);
    expect(state.mock.lastCall?.[0].request_recovery).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("普通请求在途时抑制恢复提示，收束后立即进入单请求探测", async () => {
    const active = [deferred(), deferred(), deferred()];
    const request = vi.fn<LLMClientPort["request"]>();
    for (const pending of active) request.mockReturnValueOnce(pending.promise);
    request.mockResolvedValue(response());
    const { scheduler, state } = setup(request, "A", { concurrency_limit: 2, rpm_limit: 0 });
    const results = [1, 2].map((id) =>
      scheduler.request(body(String(id)), new AbortController().signal),
    );
    active[0]!.resolve(failure());
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.mock.lastCall?.[0].request_recovery).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    active[1]!.resolve(failure());
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(state.mock.lastCall?.[0].request_recovery).toEqual({
      phase: "retrying",
      retry_count: 0,
      retry_limit: 10,
      attempt_timeout_seconds: 60,
    });
    active[2]!.resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(results);
    expect(state.mock.lastCall?.[0].request_recovery).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("首次故障收束期间成功恢复，待重试批次继续执行且始终隐藏提示", async () => {
    const first = deferred();
    const second = deferred();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(response());
    const { scheduler, state } = setup(request);
    const results = [
      scheduler.request(body("1"), new AbortController().signal),
      scheduler.request(body("2"), new AbortController().signal),
    ];
    first.resolve(failure());
    await vi.advanceTimersByTimeAsync(0);
    second.resolve(response());
    expect((await Promise.all(results)).every((result) => result.response_result === "ok")).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(Date.now()).toBe(0);
    expect(state.mock.calls.every(([snapshot]) => snapshot.request_recovery === null)).toBe(true);
  });

  it("在途取消沿原 signal 收束", async () => {
    const in_flight = deferred();
    let active_signal: AbortSignal | undefined;
    const { scheduler } = setup(async (_body, signal) => {
      active_signal = signal;
      return in_flight.promise;
    });
    const controller = new AbortController();
    const result = scheduler.request(body(), controller.signal);
    controller.abort();
    expect(active_signal?.aborted).toBe(true);
    in_flight.resolve(response({ cancelled: true }));
    expect(await result).toMatchObject({ cancelled: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("基础设施异常直接拒绝请求，不进入密钥恢复", async () => {
    const error = new Error("worker infrastructure");
    const { scheduler, failures, state } = setup(async () => {
      throw error;
    });
    await expect(scheduler.request(body(), new AbortController().signal)).rejects.toBe(error);
    expect(failures).not.toHaveBeenCalled();
    expect(state).toHaveBeenLastCalledWith(
      expect.objectContaining({ request_in_flight_count: 0, request_recovery: null }),
    );
  });

  it("共享 signal 取消多个排队请求时，监听回流不能再发出请求", async () => {
    const request = vi.fn(async () => response());
    const { scheduler } = setup(request, "A", { concurrency_limit: 1, rpm_limit: 60 });
    await scheduler.request(body("first"), new AbortController().signal);
    const controller = new AbortController();
    const pending = ["second", "third"].map((id) =>
      scheduler.request(body(id), controller.signal).catch((error: unknown) => error),
    );
    vi.setSystemTime(1_000);
    controller.abort();
    expect(await Promise.all(pending)).toEqual([
      expect.objectContaining({ code: "runtime.cancelled" }),
      expect.objectContaining({ code: "runtime.cancelled" }),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("并发槽与 RPM 同时满足才发请求，取消队首后后续请求仍按序推进", async () => {
    const active = deferred();
    const calls: string[] = [];
    const { scheduler } = setup(
      async (request) => {
        calls.push(request.work_unit_id);
        return calls.length === 1 ? active.promise : response();
      },
      "A\nB",
      { concurrency_limit: 1, rpm_limit: 60 },
    );
    const first = scheduler.request(body("1"), new AbortController().signal);
    const controller = new AbortController();
    const cancelled = scheduler
      .request(body("2"), controller.signal)
      .catch((error: unknown) => error);
    const third = scheduler.request(body("3"), new AbortController().signal);
    controller.abort();
    expect(await cancelled).toMatchObject({ code: "runtime.cancelled" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["1"]);
    active.resolve(response());
    await Promise.all([first, third]);
    expect(calls).toEqual(["1", "3"]);
  });
});

/** 构造真实调度器，只替换网络与观察回调。 */
function setup(
  request: LLMClientPort["request"],
  keys = "A",
  threshold = { concurrency_limit: 8, rpm_limit: 0 },
) {
  const state = vi.fn<(state: BatchTaskRequestState) => void>();
  const failures = vi.fn();
  const model = { api_key: keys, threshold };
  return {
    state,
    failures,
    scheduler: new RequestScheduler<LLMRequestBody, LLMRequestResult>({
      model,
      timeout_ms: 60_000,
      dispatch: (body, key, signal) =>
        request({ ...body, model: { ...model, api_key: key } }, signal),
      rate: new RequestRatePool().resolve(model),
      on_state: state,
      on_failure: failures,
      timeout_error,
      retry_exhausted_message,
    }),
  };
}

/** 提供完整请求事实，场景仅覆盖相关字段。 */
function response(overrides: Partial<LLMRequestResult> = {}): LLMRequestResult {
  return {
    usage_complete: true,
    response_result: "ok",
    response_think: "",
    input_tokens: 0,
    reasoning_tokens: 0,
    output_tokens: 0,
    cancelled: false,
    timeout: false,
    ...overrides,
  };
}

/** 固定提示词以观察同一逻辑请求的重新派发。 */
function body(id = "unit"): LLMRequestBody {
  return {
    run_id: "run",
    work_unit_id: id,
    model: {},
    config_snapshot: {},
    messages: [{ role: "user", content: id }],
  };
}

/** 由测试决定在途请求完成顺序，覆盖并发恢复。 */
function deferred<Result = LLMRequestResult>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
