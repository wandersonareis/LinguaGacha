import { GenericFormat, GENERIC_ITEMS_MEMBER } from "./generic/generic-format";
import { group_items } from "./shared/file-format-helpers";
import { collect_game_file_list } from "./shared/game/source-files";
import { resolve_game_source_input } from "./shared/game/source-input";
import { GameDirectoryOperations } from "./shared/game/game-directory-operations";
import { assert_game_directory_ready } from "./shared/game/directory";
import { source_diagnostic, type SourceDiagnostic } from "./shared/game/preparation";
import type { PreparedRead, PreparedSource } from "./file-format-types";
import type { GodotPackOrder } from "../../shared/godot";
import { apply_godot_pack_order, godot_pack_preview } from "./godot/source";
import { GAME_ENGINES, prepare_game_source } from "./shared/game/engines";
import type { GameImport } from "./shared/game/source-files";
import { GameFormat } from "./shared/game/format";
import {
  discover_source,
  discover_sources,
  assert_source_identities,
  type DiscoveredSource,
} from "./source-discovery";
import type { GamePrepareExecution } from "./shared/game/prepare-worker";
import { is_game_file_type, type GameFileType } from "../../shared/project-source-formats";
import {
  normalize_project_asset_path,
  SourceFilePathIndex,
} from "../../shared/project/project-asset-paths";
import type { PDFExecution } from "./pdf/pdf-worker";
import { PDFFormat } from "./pdf/pdf-format";
import path from "node:path";

import { type Item, type ItemFileType, type ItemStatus, create_item } from "../../domain/item";
import { ASSFormat } from "./subtitle/ass-ssa-format";
import { KVJSONFormat } from "./kvjson/kvjson-format";
import { MDV2Format } from "./markdown/md-v2-format";
import { MESSAGEJSONFormat } from "./messagejson/messagejson-format";
import { RenpyRpyFormat } from "./renpy-rpy/renpy-rpy-format";
import { SRTFormat } from "./subtitle/srt-format";
import { VTTFormat } from "./subtitle/vtt-format";
import { LRCFormat } from "./subtitle/lrc-format";
import { AppError, is_app_error } from "../../shared/error";
import { decode_text_content } from "../../shared/utils/text-tool";
import { JsonTool } from "../../shared/utils/json-tool";
import type { JsonValue } from "../../domain/json";
import { TRANSFormat } from "./trans/trans-format";
import { TXTFormat } from "./txt/txt-format";
import { XLSXFormat } from "./xlsx/xlsx-format";
import { EPUBFormat } from "./epub/epub-format";
import { FFXFormat } from "./ffx/ffx-format";
import { FormatPluginService } from "../plugin/format-plugin-service";
import type { DiscoveredPlugin } from "../plugin/manifest";
import type { PluginItem } from "../plugin/protocol";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import {
  type FileFormatReadResult,
  type FileFormatServiceWriteContext,
  type FileFormatServiceConfig,
  type ProjectSourceFileEntry,
} from "./file-format-types";
import {
  BUILTIN_FORMAT_CATALOG,
  type FormatCatalogEntry,
  type ProjectSourceFormatHitCounts,
  type ProjectSourceFileSummary,
  type SourceConfirmations,
} from "../../shared/project-source-formats";

/** 新建和追加导入共用写入前的确认事实，避免两个入口漏掉备份或包顺序确认。 */
export function read_source_confirmations(
  entries: readonly DiscoveredSource[],
): SourceConfirmations {
  const godot_packs = entries.flatMap((entry) =>
    entry.source.kind === "game" && entry.source.file_type === "GODOT"
      ? [godot_pack_preview(entry.source.game)]
      : [],
  );
  return {
    contains_game: entries.some((entry) => entry.source.kind === "game"),
    ...(godot_packs.length ? { godot_packs } : {}),
  };
}

/** 插件只接收公开字段；工程身份与状态留在核心。 */
function to_plugin_item(item: Item): PluginItem {
  return {
    src: item.src,
    dst: item.dst,
    name_src: item.name_src,
    name_dst: item.name_dst,
    extra_field: item.extra_field,
    tag: item.tag,
    row: item.row,
    file_type: item.file_type,
  };
}

/** 文件格式门面负责来源准备，并按固定配置分发解析和写回。 */
export class FileFormatService {
  /** 文件重置由格式决定翻译资格，工程服务不解释私有定位。 */
  public static default_status(item: Pick<Item, "file_type" | "extra_field">): ItemStatus {
    if (is_game_file_type(item.file_type)) return GAME_ENGINES[item.file_type].default_status(item);
    return "NONE";
  }

  private readonly native_fs: NativeFs; // 文件发现与字幕写入复用的磁盘入口
  private readonly target_language: string; // 插件宿主与内置格式共用的项目目标语言
  private readonly formats: readonly FormatCatalogEntry[]; // 内置 + 已启用插件的生效目录
  private readonly file_formats: readonly FormatCatalogEntry[]; // 来源发现只消费文件级条目
  // 格式处理器随服务实例固定，解析与写回始终复用同一组配置。
  private readonly generic = new GenericFormat();
  private readonly media = new GenericFormat("MEDIA");
  private readonly txt: TXTFormat;
  private readonly md: MDV2Format;
  private readonly ass: ASSFormat;
  private readonly srt: SRTFormat;
  private readonly vtt: VTTFormat;
  private readonly lrc: LRCFormat;
  private readonly kvjson: KVJSONFormat;
  private readonly messagejson: MESSAGEJSONFormat;
  private readonly xlsx: XLSXFormat;
  private readonly trans: TRANSFormat;
  private readonly renpy_rpy: RenpyRpyFormat;
  private readonly epub: EPUBFormat;
  private readonly ffx: FFXFormat;
  private readonly games: Record<GameFileType, GameFormat>;

  /**
   * 构造时固定各格式处理器，保证一次服务实例内配置一致
   */
  public constructor(
    private readonly game_directory_operations: GameDirectoryOperations,
    config: FileFormatServiceConfig,
    private readonly pdf_execution: PDFExecution,
    native_fs: NativeFs = default_native_fs,
    private readonly game_prepare_execution?: GamePrepareExecution,
    private readonly plugin_service?: FormatPluginService,
  ) {
    this.native_fs = native_fs;
    this.target_language = config.target_language;
    this.formats = plugin_service?.catalog() ?? BUILTIN_FORMAT_CATALOG;
    this.file_formats = this.formats.filter((format) => format.source_kind === "file");
    this.games = Object.fromEntries(
      Object.entries(GAME_ENGINES).map(([type, engine]) => [
        type,
        new GameFormat(this.game_directory_operations, engine.create_adapter(), native_fs),
      ]),
    ) as Record<GameFileType, GameFormat>;
    this.txt = new TXTFormat();
    this.md = new MDV2Format();
    this.ass = new ASSFormat();
    this.srt = new SRTFormat();
    this.vtt = new VTTFormat(config);
    this.lrc = new LRCFormat();
    this.kvjson = new KVJSONFormat();
    this.messagejson = new MESSAGEJSONFormat();
    this.xlsx = new XLSXFormat();
    this.trans = new TRANSFormat();
    this.renpy_rpy = new RenpyRpyFormat();
    this.epub = new EPUBFormat(config);
    this.ffx = new FFXFormat(config.target_language);
  }

  /**
   * 保存身份优先分发，新来源的 JSON 和 XLSX 按内容识别。
   */
  public async parse_asset(
    rel_path: string,
    content: Uint8Array,
    file_type?: string,
    signal?: AbortSignal,
  ): Promise<FileFormatReadResult> {
    if (is_game_file_type(file_type))
      return {
        kind: "items",
        file_type,
        ...(await this.games[file_type].read_from_stream(content, rel_path, signal)),
      };
    // 插件先于内置分发：已保存身份直接命中，新来源先内容识别再按独占扩展名命中。
    const plugin = await this.plugin_for_asset(file_type, rel_path, content);
    if (plugin !== undefined) return await this.read_plugin_asset(plugin, rel_path, content);
    const by_extension: Record<string, string> = {
      ".txt": "TXT",
      ".md": "MD_V2",
      ".ass": "ASS",
      ".ssa": "ASS",
      ".srt": "SRT",
      ".vtt": "VTT",
      ".lrc": "LRC",
      ".epub": "EPUB",
      ".rpy": "RENPY_RPY",
      ".trans": "TRANS",
      ".pdf": "PDF",
      ".generic": "GENERIC",
      ".media": "MEDIA",
    };
    let type =
      (file_type === "NONE" ? undefined : file_type) ??
      by_extension[path.extname(rel_path).toLowerCase()];
    // 新来源先尝试 FFX 内容识别；已保存的标准 JSON/XLSX 身份保持不变。
    if (type === undefined || type.startsWith("FFX_")) {
      const ffx = await this.try_read_ffx(content, rel_path);
      if (ffx !== null) return ffx;
      if (type?.startsWith("FFX_"))
        return { kind: "items", file_type: type as ItemFileType, items: [] };
    }
    if (
      type === "KVJSON" ||
      type === "MESSAGEJSON" ||
      (type === undefined && path.extname(rel_path).toLowerCase() === ".json")
    ) {
      const text = await decode_text_content(content);
      // 新来源保持标准 JSON 接受范围，已保存身份沿用历史非有限数值兼容。
      const data =
        type === undefined
          ? (JSON.parse(text) as JsonValue)
          : JsonTool.parseStrict<JsonValue>(text);
      type ??= Array.isArray(data)
        ? "MESSAGEJSON"
        : data !== null && typeof data === "object"
          ? "KVJSON"
          : "NONE";
      return {
        kind: "items",
        file_type: type as ItemFileType,
        items:
          type === "KVJSON"
            ? this.kvjson.read_items(data, rel_path)
            : type === "MESSAGEJSON"
              ? this.messagejson.read_items(data, rel_path)
              : [],
      };
    }
    if (type === "TRANS")
      return { kind: "items", file_type: type, ...this.trans.read_from_stream(content, rel_path) };
    if (type === "PDF")
      return {
        kind: "pdf",
        document: await new PDFFormat(this.pdf_execution).read_from_stream(content),
      };
    if (
      type === "XLSX" ||
      type === "WOLFXLSX" ||
      (type === undefined && path.extname(rel_path).toLowerCase() === ".xlsx")
    )
      return {
        kind: "items",
        ...(await this.xlsx.read_asset(
          content,
          rel_path,
          file_type === "XLSX" || file_type === "WOLFXLSX" ? file_type : undefined,
        )),
      };
    const formats = {
      GENERIC: this.generic,
      MEDIA: this.media,
      TXT: this.txt,
      MD_V2: this.md,
      ASS: this.ass,
      SRT: this.srt,
      VTT: this.vtt,
      LRC: this.lrc,
      EPUB: this.epub,
      RENPY_RPY: this.renpy_rpy,
    };
    if (!type || !Object.hasOwn(formats, type))
      return { kind: "items", file_type: "NONE", items: [] };
    const format = formats[type as keyof typeof formats];
    return {
      kind: "items",
      file_type: type as ItemFileType,
      items: await format.read_from_stream(content, rel_path),
    };
  }

  /** 只让 FFX 处理器认领其支持的扩展名，标准格式继续走既有分发。 */
  private async try_read_ffx(
    content: Uint8Array,
    rel_path: string,
  ): Promise<FileFormatReadResult | null> {
    const extension = path.extname(rel_path).toLowerCase();
    if (![".json", ".csv", ".xlsx", ".strings", ".po"].includes(extension)) return null;
    const result = await this.ffx.read_from_stream(content, rel_path);
    return result.file_type.startsWith("FFX_") ? { kind: "items", ...result } : null;
  }

  /** 已保存身份优先；新来源按内容识别顺序尝试，再回退独占扩展名。 */
  private async plugin_for_asset(
    file_type: string | undefined,
    rel_path: string,
    content: Uint8Array,
  ): Promise<DiscoveredPlugin | undefined> {
    const service = this.plugin_service;
    if (service === undefined) return undefined;
    if (file_type !== undefined) return service.plugin_for_file_type(file_type);
    const extension = path.extname(rel_path).toLowerCase();
    for (const plugin of service.content_plugins(extension)) {
      const supervisor = service.supervisor(plugin, this.target_language);
      if (await supervisor.detect(rel_path, content)) return plugin;
    }
    return service.plugin_for_extension(extension);
  }

  /** 插件条目补齐工程身份；文件级格式身份由插件清单校验后决定。 */
  private async read_plugin_asset(
    plugin: DiscoveredPlugin,
    rel_path: string,
    content: Uint8Array,
  ): Promise<FileFormatReadResult> {
    const service = this.plugin_service!;
    const result = await service.supervisor(plugin, this.target_language).read(rel_path, content);
    return {
      kind: "items",
      file_type: result.file_type,
      items: result.items.map((item) =>
        create_item({ ...item, file_type: result.file_type, file_path: rel_path }),
      ),
    };
  }

  /** 来源发现到原稿固化共用一次占用，内部发现与准备不重复申请。 */
  public async with_source_directories<T>(
    source_paths: readonly string[],
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const directories = source_paths.map((input) => {
      try {
        return resolve_game_source_input(input, this.native_fs)?.root ?? input;
      } catch {
        // 来源检查统一归集读取失败；失败的 EXE 仍保守占用其父目录。
        return path.extname(input).toLowerCase() === ".exe" ? path.dirname(input) : input;
      }
    });
    return this.game_directory_operations.run(directories, operation, signal);
  }

  /** 新建、摘要和预览共用发现结果，正式导入重新识别本次选定来源。 */
  public async collect_source_file_entries(
    source_paths: string[],
    signal?: AbortSignal,
    orders?: readonly GodotPackOrder[],
  ): Promise<DiscoveredSource[]> {
    return this.apply_godot_orders(
      await discover_sources(source_paths, this.native_fs, signal, this.file_formats),
      orders,
    );
  }

  /** 导入确认后的目标路径固定。识别错误也保留在同一批次中。 */
  public async discover_import_sources(
    entries: readonly ProjectSourceFileEntry[],
    signal?: AbortSignal,
    orders?: readonly GodotPackOrder[],
  ): Promise<DiscoveredSource[]> {
    const result: DiscoveredSource[] = [];
    for (const entry of entries) {
      const resolved = await discover_source(entry.source_path, this.native_fs, signal, this.file_formats);
      const file_type = entry.file_type ?? resolved.file_type;
      // 游戏容器只能由同一引擎的来源形成，身份不符时来源无法交付目标资产的原稿。
      const mismatched =
        resolved.source.kind !== "failure" &&
        file_type !== resolved.file_type &&
        (is_game_file_type(file_type) || resolved.source.kind === "game");
      result.push({
        ...resolved,
        rel_path: entry.rel_path,
        file_type,
        ...(mismatched && {
          source: {
            kind: "failure",
            error: new AppError("file.invalid_structure", {
              public_details: { file: entry.rel_path },
            }),
          },
        }),
      });
    }
    assert_source_identities(result, this.native_fs);
    return this.apply_godot_orders(result, orders);
  }

  /** 正式请求的全部顺序先校验，任何错误都早于准备写入。 */
  private apply_godot_orders(
    entries: DiscoveredSource[],
    orders?: readonly GodotPackOrder[],
  ): DiscoveredSource[] {
    if (!orders) return entries;
    const remaining = new Set(orders);
    const result = entries.map((entry) => {
      const source = entry.source;
      if (source.kind !== "game" || source.file_type !== "GODOT") return entry;
      const order = orders.find(
        (order) =>
          this.native_fs.to_identity_path(order.game_root) ===
          this.native_fs.to_identity_path(source.game.root),
      );
      if (!order) return entry;
      remaining.delete(order);
      return { ...entry, source: { ...source, game: apply_godot_pack_order(source.game, order) } };
    });
    if (remaining.size) throw new AppError("request.validation_failed");
    return result;
  }

  /** 在冲突层级分配数字后缀，工作台预览可显式保留同名替换。 */
  public assign_source_file_paths<T extends ProjectSourceFileEntry>(
    entries: readonly T[],
    existing_files: readonly { path: string; file_type: string }[] = [],
    replace_same_path = false,
  ): T[] {
    const existing = new SourceFilePathIndex();
    for (const file of existing_files) existing.add(file.path, file.file_type);
    const original = new SourceFilePathIndex(); // 自动名称不能抢占尚未分配的原始候选。
    for (const entry of entries) original.reserve(entry.rel_path, entry.file_type);
    const assigned = new SourceFilePathIndex();
    const result: T[] = [...entries];
    const directories = new Map<string, string>(); // 同一准备操作中的目录前缀只改名一次，子文件共同迁移。
    // 普通目录先占位，游戏避让。结果仍按用户输入顺序返回。
    const order = entries
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          Number(is_game_file_type(left.entry.file_type)) -
          Number(is_game_file_type(right.entry.file_type)),
      );
    for (const { entry, index } of order) {
      const parts = normalize_project_asset_path(entry.rel_path).split("/");
      for (let length = 1; length < parts.length; length += 1) {
        const renamed = directories.get(parts.slice(0, length).join("/").toLowerCase());
        if (renamed !== undefined) {
          parts.splice(0, length, ...renamed.split("/"));
          break;
        }
      }
      let candidate = path.join(...parts);
      const unchanged =
        normalize_project_asset_path(candidate) === normalize_project_asset_path(entry.rel_path);
      const conflict =
        existing.find_conflict(candidate, entry.file_type, unchanged && replace_same_path) ??
        assigned.find_conflict(candidate, entry.file_type);
      if (conflict !== null) {
        const component = conflict.split("/").length - 1;
        const prefix = parts.slice(0, component + 1);
        const is_directory = component < parts.length - 1;
        const parsed = !is_directory
          ? path.parse(prefix[component]!)
          : { name: prefix[component]!, ext: "" };
        let suffix = 2;
        let renamed: string;
        do {
          prefix[component] = parsed.name + "_" + suffix + parsed.ext;
          renamed = prefix.join("/");
          suffix += 1;
        } while (
          existing.find_conflict(renamed, is_directory ? undefined : entry.file_type) !== null ||
          assigned.find_conflict(renamed, is_directory ? undefined : entry.file_type) !== null ||
          original.find_conflict(renamed, is_directory ? undefined : entry.file_type) !== null
        );
        if (is_directory)
          directories.set(
            parts
              .slice(0, component + 1)
              .join("/")
              .toLowerCase(),
            renamed,
          );
        parts.splice(0, component + 1, ...prefix);
        candidate = path.join(...parts);
      }
      assigned.add(candidate, entry.file_type);
      result[index] = { ...entry, rel_path: candidate };
    }
    return result;
  }

  /** 正式导入准备游戏并固化容器后返回原稿。 */
  public async prepare_source(
    entry: DiscoveredSource,
    signal?: AbortSignal,
  ): Promise<PreparedSource> {
    signal?.throwIfAborted();
    const { source, rel_path } = entry;
    if (source.kind === "failure") throw source.error;
    if (source.kind !== "file") {
      assert_game_directory_ready(source.game.root, this.native_fs);
      const format = this.games[source.file_type];
      const engine = GAME_ENGINES[source.file_type];
      const diagnostics: SourceDiagnostic[] = [];
      let captured: { content: Uint8Array; read?: PreparedRead } | undefined;
      let directory_changed = false;
      let archive_error: unknown;
      try {
        await prepare_game_source(
          source,
          this.native_fs,
          this.game_prepare_execution,
          signal,
          async (prepared) => {
            diagnostics.push(...prepared.diagnostics);
            directory_changed =
              prepared.changes !== null &&
              (prepared.changes.writes.length > 0 || Boolean(prepared.changes.removes?.length));
            const files = new Map(prepared.sources.files);
            let members_complete = true; // 只追踪本次原稿收集的读取遗漏。
            const sources = {
              ...prepared.sources,
              files,
              on_read_failure: (diagnostic: SourceDiagnostic) => {
                members_complete = false;
                if (!diagnostics.some((existing) => existing.member === diagnostic.member))
                  diagnostics.push(diagnostic);
                if (diagnostic.member) files.set(diagnostic.member, null);
              },
            };
            try {
              const translation = await engine.collect(source, this.native_fs, signal, sources);
              const file_list = collect_game_file_list(
                source.game.root,
                this.native_fs,
                signal,
                sources,
              );
              // 导入语义只消费即将固化的同一份快照，已完成的读取随原稿交付，避免固化后再次解析。
              let imported: GameImport | undefined;
              let read: PreparedRead | undefined;
              try {
                imported = await engine.prepare_import?.(
                  source,
                  { data: translation, files: file_list, complete: members_complete },
                  this.native_fs,
                  signal,
                  (diagnostic) => diagnostics.push(diagnostic),
                );
              } catch (error) {
                signal?.throwIfAborted();
                read = { ok: false, error };
              }
              const content = await format.create_container(
                translation,
                rel_path,
                file_list.join("\n"),
                signal,
                imported?.metadata,
              );
              if (imported?.read)
                read = {
                  ok: true,
                  result: {
                    kind: "items",
                    file_type: source.file_type,
                    ...format.collect_read(imported.read, rel_path),
                  },
                };
              captured = {
                content,
                ...(read && { read }),
              };
            } catch (error) {
              signal?.throwIfAborted();
              archive_error = error;
            }
          },
          this.game_directory_operations.report_cleanup,
        );
      } catch (error) {
        if (signal?.aborted) throw error; // 目录恢复失败保留完整异常和恢复材料位置。
        if (!captured) throw error;
        directory_changed = is_app_error(error) && error.public_details?.directory_changed === true;
        diagnostics.push(source_diagnostic("directory", error));
      }
      if (!captured)
        throw new AppError("file.parse_failed", {
          cause: archive_error,
          public_details: { directory_changed },
        });
      return { ...captured, directory_changed, diagnostics };
    }
    return {
      content: this.native_fs.read_file(entry.source_path),
      directory_changed: false,
      diagnostics: [],
    };
  }

  /**
   * 按文件发现的同一去重口径汇总总数和互斥扩展名命中数，不提前解析文件内容。
   */
  public async summarize_source_files(
    source_paths: string[],
  ): Promise<Omit<ProjectSourceFileSummary, "project_name">> {
    const entries = await this.with_source_directories(source_paths, (signal) =>
      this.collect_source_file_entries(source_paths, signal),
    );
    const source_files = entries.filter((entry) => entry.source.kind !== "failure");
    const format_hit_counts = Object.fromEntries(
      this.formats.map((format) => [format.id, 0]),
    ) as ProjectSourceFormatHitCounts;

    for (const source_file of source_files) {
      const source = source_file.source;
      const format_id =
        source.kind === "game"
          ? this.formats.find(
              (format) => format.source_kind === "game" && format.file_type === source.file_type,
            )?.id
          : source.kind === "file"
            ? source.format
            : undefined;
      if (format_id !== undefined) {
        format_hit_counts[format_id] = (format_hit_counts[format_id] ?? 0) + 1;
      }
    }

    return {
      ...read_source_confirmations(source_files),
      source_file_count: source_files.length,
      format_hit_counts,
    };
  }

  /** 按格式分发生成，容器与记录格式遍历资产集合以覆盖零条目文件。 */
  public async write_items(
    items: Item[],
    context: FileFormatServiceWriteContext,
    writeback_path?: string, // 通用与视频写回输入仅在调用方指定独立目录时生成。
    bilingual_files?: readonly string[],
  ): Promise<void> {
    const { paths, asset_reader } = context;
    const failures: unknown[] = [];
    for (const game of Object.values(this.games)) {
      try {
        await game.write_to_path(items, context);
      } catch (error) {
        if (error instanceof AppError && error.code === "runtime.disposed") throw error;
        failures.push(error);
      }
    }
    await this.txt.write_to_path(items, paths, bilingual_files);
    await this.md.write_to_path(items, paths);
    await this.write_subtitles(items, context, bilingual_files);
    await this.kvjson.write_to_path(items, paths, asset_reader);
    await this.write_messagejson(items, context);
    if (writeback_path !== undefined) {
      // 视频字幕的样式与渲染归 Agent，与通用数据共用写回输入。
      const groups = { GENERIC: group_items(items, "GENERIC"), MEDIA: group_items(items, "MEDIA") };
      for (const file of context.source_files) {
        if (file.file_type !== "GENERIC" && file.file_type !== "MEDIA") continue;
        const asset = await asset_reader(file.path);
        if (asset === null)
          throw new AppError("file.not_found", { public_details: { file: file.path } });
        const output = await this.generic.render_text(
          asset,
          groups[file.file_type].get(file.path) ?? [],
          file.path,
        );
        await this.native_fs.write_file(
          path.join(writeback_path, file.path, GENERIC_ITEMS_MEMBER),
          output,
        );
      }
    }
    await this.xlsx.write_to_path(items, paths, asset_reader);
    await this.trans.write_to_path(items, paths, asset_reader);
    await this.renpy_rpy.write_to_path(items, paths, asset_reader);
    await this.epub.write_to_path(items, paths, asset_reader, bilingual_files);
    await this.ffx.write_to_path(items, paths, asset_reader);
    await this.write_plugins(items, context);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Game assets could not be exported");
  }

  /** 插件写回与内置格式共用目标目录，失败进入统一聚合错误。 */
  private async write_plugins(
    items: Item[],
    context: FileFormatServiceWriteContext,
  ): Promise<void> {
    const service = this.plugin_service;
    if (service === undefined) return;
    const grouped = new Map<DiscoveredPlugin, Map<string, Item[]>>();
    for (const item of items) {
      const plugin = service.plugin_for_file_type(item.file_type);
      if (plugin === undefined) continue;
      const files = grouped.get(plugin) ?? new Map<string, Item[]>();
      const group = files.get(item.file_path) ?? [];
      group.push(item);
      files.set(item.file_path, group);
      grouped.set(plugin, files);
    }
    for (const [plugin, files] of grouped) {
      const supervisor = service.supervisor(plugin, this.target_language);
      for (const [rel_path, group] of files) {
        const asset = await context.asset_reader(rel_path);
        if (asset === null) {
          throw new AppError("file.not_found", { public_details: { file: rel_path } });
        }
        const written = await supervisor.write(
          rel_path,
          group.map(to_plugin_item),
          new Uint8Array(asset),
        );
        if (written.translated !== undefined) {
          await this.native_fs.write_file(
            path.join(context.paths.translated_path, rel_path),
            written.translated,
          );
        }
        if (written.bilingual !== undefined) {
          await this.native_fs.write_file(
            path.join(context.paths.bilingual_path, rel_path),
            written.bilingual,
          );
        }
      }
    }
  }

  /** 资产集合驱动 MESSAGEJSON 导出，零条目文件也完整保留源结构。 */
  private async write_messagejson(
    items: Item[],
    context: FileFormatServiceWriteContext,
  ): Promise<void> {
    const groups = group_items(items, "MESSAGEJSON");
    for (const { path: file, file_type } of context.source_files) {
      if (file_type !== "MESSAGEJSON") continue;
      const asset = await context.asset_reader(file);
      if (asset === null) throw new AppError("file.not_found", { public_details: { file } });
      const output = this.messagejson.render_text(
        await decode_text_content(asset),
        groups.get(file) ?? [],
        file,
      );
      await this.native_fs.write_file(path.join(context.paths.translated_path, file), output);
    }
  }

  /** 文件集合拥有导出调度，格式处理器只组装当前文件的两种正文。 */
  private async write_subtitles(
    items: Item[],
    context: FileFormatServiceWriteContext,
    bilingual_files?: readonly string[],
  ): Promise<void> {
    const by_file = new Map<string, Item[]>();
    for (const item of items) {
      const group = by_file.get(item.file_path) ?? [];
      group.push(item);
      by_file.set(item.file_path, group);
    }
    for (const record of context.source_files) {
      const file = record.path;
      const file_items = by_file.get(file) ?? [];
      const file_type = record.file_type as ItemFileType;
      const subtitle = this.read_subtitle_format(file_type);
      if (!subtitle) continue;
      const asset = await context.asset_reader(file);
      if (asset === null) throw new AppError("file.not_found", { public_details: { file } });
      const text = await decode_text_content(asset);
      const output = subtitle.format.render_text(text, file_items, file);
      // 格式计算和校验完成后才落盘，避免单语写出后才发现双语结构错误。
      await this.native_fs.write_file(
        path.join(context.paths.translated_path, file),
        output.translated,
      );
      if (bilingual_files === undefined || bilingual_files.includes(file))
        await this.native_fs.write_file(
          path.join(context.paths.bilingual_path, file),
          output.bilingual,
        );
    }
  }

  /** 导入与导出共用处理器选择，来源类型与扩展名别名汇入同一入口。 */
  private read_subtitle_format(file_type: ItemFileType | null): {
    file_type: ItemFileType;
    format: ASSFormat | SRTFormat | VTTFormat | LRCFormat;
  } | null {
    switch (file_type) {
      case "ASS":
        return { file_type, format: this.ass };
      case "SRT":
        return { file_type, format: this.srt };
      case "VTT":
        return { file_type, format: this.vtt };
      case "LRC":
        return { file_type, format: this.lrc };
      default:
        return null;
    }
  }
}
