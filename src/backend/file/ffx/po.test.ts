import { describe, expect, it } from "vitest";

import { JsonTool } from "../../../shared/utils/json-tool";
import { is_po_document, read_po_items, render_po } from "./po";

const SOURCE = [
  'msgid ""',
  'msgstr ""',
  '"Project-Id-Version: FFX Resources\\n"',
  '"MIME-Version: 1.0\\n"',
  '"Content-Type: text/plain; charset=UTF-8\\n"',
  '"Content-Transfer-Encoding: 8bit\\n"',
  '"Language: pt-BR\\n"',
  "",
  '#. import: {"file":"ffx/battle/btl/bika00_10/bika00_10.bin","name":"bika00_10","index":0,"lang":"us","hash":"$45c331fabe140a27"}',
  "#: ffx/battle/btl/bika00_10/bika00_10.bin:0",
  'msgctxt "bika00_10|0"',
  'msgid "{PC:00:TIDUS}{TEXT_NEWLINE}Whew!"',
  'msgstr "{PC:00:TIDUS}{TEXT_NEWLINE}Uau!"',
  "",
  '#. import: {"file":"ffx/battle/kernel/a_ability.bin","name":"a_ability","index":0,"field":"Desc.Standard","lang":"us","hash":"$22c0c430ff567b99"}',
  "#. ref[sp]: Ver los datos del enemigo.",
  "#: ffx/battle/kernel/a_ability.bin:0",
  'msgctxt "a_ability|0|Desc.Standard"',
  'msgid "View \\"enemy\\" data."',
  'msgstr "Mostra os dados \\"do inimigo\\"."',
  "",
  "#: fallback/plain.po.bin:7",
  'msgctxt "plain_file|7"',
  'msgid "Fallback entry"',
  'msgstr ""',
  "",
  "#: continued/plain.po.bin:3",
  'msgid "continued "',
  '"text"',
  'msgstr "joined "',
  '"translation"',
  "",
  'msgid "plural source"',
  'msgid_plural "plural sources"',
  'msgstr[0] "one"',
  'msgstr[1] "many"',
  "",
  '#~ msgid "obsolete"',
  '#~ msgstr "old"',
  "",
].join("\n");

function read_extra(item: ReturnType<typeof read_po_items>[number]): Record<string, unknown> {
  return JsonTool.parseStrict(item.extra_field as string) as Record<string, unknown>;
}

describe("FFX PO", () => {
  it("扩展名识别后按 gettext 结构校验内容", () => {
    expect(is_po_document(SOURCE)).toBe(true);
    expect(is_po_document("plain text without gettext entries")).toBe(false);
    expect(is_po_document('msgid "source"')).toBe(false);
  });

  it("读取 source/target、元数据和字段坐标", () => {
    const items = read_po_items(SOURCE, "battle.po");

    expect(items.map((item) => item.src)).toEqual([
      "{PC:00:TIDUS}{TEXT_NEWLINE}Whew!",
      'View "enemy" data.',
      "Fallback entry",
      "continued text",
    ]);
    expect(items.map((item) => item.row)).toEqual([0, 0, 7, 3]);
    expect(items.map((item) => item.tag)).toEqual([
      "ffx/battle/btl/bika00_10/bika00_10.bin",
      "ffx/battle/kernel/a_ability.bin",
      "fallback/plain.po.bin",
      "continued/plain.po.bin",
    ]);
    expect(items[0]).toMatchObject({
      dst: "",
      file_type: "FFX_PO",
      file_path: "battle.po",
      status: "NONE",
    });

    const first = read_extra(items[0]!);
    expect(first["ffx_key"]).toBe("ffx/battle/btl/bika00_10/bika00_10.bin");
    expect(first["ffx_po_name"]).toBe("bika00_10");
    expect(first["ffx_translations"]).toMatchObject({
      us: {
        text: "{PC:00:TIDUS}{TEXT_NEWLINE}Whew!",
        hash: "45c331fabe140a27",
        source: "{PC:00:TIDUS}{TEXT_NEWLINE}Whew!",
        target: "{PC:00:TIDUS}{TEXT_NEWLINE}Uau!",
      },
    });

    const second = read_extra(items[1]!);
    expect(second["ffx_po_field"]).toBe("Desc.Standard");
    expect(second["ffx_translations"]).toMatchObject({
      sp: { text: "Ver los datos del enemigo.", hash: "" },
    });
  });

  it("跳过复数形式和废弃条目", () => {
    const items = read_po_items(SOURCE, "battle.po");

    expect(items.some((item) => item.src.startsWith("plural"))).toBe(false);
    expect(items.some((item) => item.src === "obsolete")).toBe(false);
  });

  it("导出已处理译文，未处理条目保留原 msgstr", () => {
    const items = read_po_items(SOURCE, "battle.po");
    const output = render_po(
      items.map((item, index) =>
        index === 0 ? { ...item, status: "PROCESSED" as const, dst: "Novo texto" } : item,
      ),
      "PT",
    );

    expect(output).toContain('"Language: PT\\n"');
    expect(output).toContain(
      '#. import: {"file":"ffx/battle/btl/bika00_10/bika00_10.bin","name":"bika00_10","index":0,"lang":"us","hash":"$45c331fabe140a27"}',
    );
    expect(output).toContain('msgctxt "bika00_10|0"');
    expect(output).toContain('msgstr "Novo texto"');
    expect(output).toContain('msgstr "Mostra os dados \\"do inimigo\\"."');
    expect(output).toContain('msgid "View \\"enemy\\" data."');
    expect(output).toContain("#. ref[sp]: Ver los datos del enemigo.");

    const reread = read_po_items(output, "battle.po");
    expect(reread.map((item) => item.src)).toEqual(items.map((item) => item.src));
    expect(reread[1]).toMatchObject({
      src: 'View "enemy" data.',
      row: 0,
      tag: "ffx/battle/kernel/a_ability.bin",
    });
  });
});
