import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { create_item } from "../../../domain/item";
import { spreadsheet_fixture } from "../../../test/spreadsheet-fixture";
import { FFXFormat } from "./ffx-format";

describe("FFXFormat", () => {
  it("读取 FFX JSON 并保留条目身份", async () => {
    const format = new FFXFormat("PT");
    const content = Buffer.from(
      JSON.stringify({
        battle: {
          metadata: { key: "battle", id: "battle" },
          rows: [
            {
              index: 0,
              name: "Potion",
              hash: { us: "$abc" },
              text: { us: "Potion", pt: "Poção" },
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await format.read_from_stream(content, "resources.json");

    expect(result).toMatchObject({
      file_type: "FFX_JSON",
      items: [{ src: "Potion", dst: "", row: 0, tag: "battle", status: "NONE" }],
    });
  });

  it("读取 FFX CSV 并按 key 与 index 合并语言行", async () => {
    const format = new FFXFormat("PT");
    const content = Buffer.from(
      [
        "key,id,name,index,lang,hash,text,divergent",
        "battle,1,Potion,0,us,abc,Potion,false",
        "battle,1,Potion,0,pt,def,Poção,false",
      ].join("\n"),
      "utf8",
    );

    const result = await format.read_from_stream(content, "resources.csv");

    expect(result).toMatchObject({
      file_type: "FFX_CSV",
      items: [{ src: "Potion", dst: "", row: 0, tag: "battle", status: "NONE" }],
    });
  });

  it("读取 FFX XLSX 并按 key 与 index 合并语言行", async () => {
    const format = new FFXFormat("PT");
    const content = await spreadsheet_fixture({
      A1: "key",
      B1: "id",
      C1: "name",
      D1: "index",
      E1: "lang",
      F1: "hash",
      G1: "text",
      H1: "source",
      I1: "target",
      J1: "divergent",
      A2: "battle",
      B2: "1",
      C2: "Potion",
      D2: "0",
      E2: "us",
      F2: "abc",
      G2: "Potion",
      H2: "",
      I2: "",
      J2: "false",
      A3: "battle",
      B3: "1",
      C3: "Potion",
      D3: "0",
      E3: "pt",
      F3: "def",
      G3: "Poção",
      H3: "",
      I3: "",
      J3: "false",
    });

    const result = await format.read_from_stream(content, "resources.xlsx");

    expect(result).toMatchObject({
      file_type: "FFX_XLSX",
      items: [{ src: "Potion", dst: "", row: 0, tag: "battle", status: "NONE" }],
    });
  });

  it("读取 FFX XLSX antigo (8 colunas, sem source/target)", async () => {
    const content = await spreadsheet_fixture({
      A1: "key",
      B1: "id",
      C1: "name",
      D1: "index",
      E1: "lang",
      F1: "hash",
      G1: "text",
      H1: "divergent",
      A2: "battle",
      B2: "1",
      C2: "Potion",
      D2: "0",
      E2: "us",
      F2: "abc",
      G2: "Potion",
      H2: "false",
      A3: "battle",
      B3: "1",
      C3: "Potion",
      D3: "0",
      E3: "pt",
      F3: "def",
      G3: "Poção",
      H3: "false",
    });

    const result = await new FFXFormat("PT").read_from_stream(content, "resources.xlsx");

    expect(result).toMatchObject({
      file_type: "FFX_XLSX",
      items: [{ src: "Potion", dst: "", row: 0, tag: "battle", status: "NONE" }],
    });
  });

  it("读取 FFX Strings 并保留文件键与行号", async () => {
    const format = new FFXFormat("PT");
    const content = Buffer.from(
      ["/*key=battle row_count=1*/", "battle:0:us║$abc = Potion"].join("\n"),
      "utf8",
    );

    const result = await format.read_from_stream(content, "resources.strings");

    expect(result).toMatchObject({
      file_type: "FFX_STRINGS",
      items: [{ src: "Potion", dst: "", row: 0, tag: "battle", status: "NONE" }],
    });
  });

  it("读取 FFX Strings v2 并按行语言还原 source/target", async () => {
    const format = new FFXFormat("PT");
    const content = Buffer.from(
      [
        "/*key=part1/zone/z002/txtres row_count=2 version=2 source=us target=br*/",
        "zone/z002/txtres:$row0:0:us║$0000000000000001 = Hello",
        "zone/z002/txtres:$row0:0:br║$0000000000000002 = Olá",
        "zone/z002/txtres:$row0:0:jp║$0000000000000003 = こんにちは",
        "zone/z002/txtres:$row1:1:us║$0000000000000001 = $0000000000000001",
        "zone/z002/txtres:$row1:1:jp║$0000000000000003 = こんにちは",
      ].join("\n"),
      "utf8",
    );

    const result = await format.read_from_stream(content, "ac.strings");

    expect(result.file_type).toBe("FFX_STRINGS");
    expect(result.items).toHaveLength(2);
    const [first, second] = result.items;
    expect(first).toMatchObject({
      src: "Hello",
      dst: "",
      row: 0,
      tag: "zone/z002/txtres",
      status: "NONE",
    });

    const extra = JSON.parse(String(first!.extra_field));
    expect(extra).toMatchObject({
      ffx_key: "zone/z002/txtres",
      ffx_name: "$row0",
      ffx_metadata: {
        key: "part1/zone/z002/txtres",
        rowCount: 2,
        version: 2,
        source: "us",
        target: "br",
      },
    });
    expect(extra.ffx_translations).toMatchObject({
      us: { text: "Hello", hash: "0000000000000001" },
      br: { text: "Olá", hash: "0000000000000002" },
      jp: { text: "こんにちは", hash: "0000000000000003" },
    });
    // A ref "$hash" é resolvida pela tabela do próprio arquivo.
    expect(second).toMatchObject({ src: "Hello", row: 1, tag: "zone/z002/txtres" });
  });

  it("读取 FFX Strings v2 时 desfaz o escape do valor", async () => {
    const format = new FFXFormat("PT");
    const content = Buffer.from(
      [
        "/*key=zone/z004/txtres row_count=1 version=2 source=us target=br*/",
        "zone/z004/txtres:0:us║$0000000000000001 = Line 1\\nLine 2\\║tail",
      ].join("\n"),
      "utf8",
    );

    const result = await format.read_from_stream(content, "resources.strings");

    expect(result.items[0]!.src).toBe("Line 1\nLine 2║tail");
  });

  it("写回 FFX Strings 时保持 v2 e preserva as referências", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-"));
    const original = Buffer.from(
      [
        "/*key=part1/zone/z002/txtres row_count=1 version=2 source=us target=br*/",
        "zone/z002/txtres:$row0:0:us║$0000000000000001 = Hello",
        "zone/z002/txtres:$row0:0:br║$0000000000000002 = Olá",
        "zone/z002/txtres:$row0:0:jp║$0000000000000003 = こんにちは",
        "/*key=part1/zone/z003/txtres row_count=1 version=2 source=us target=br*/",
        "zone/z003/txtres:$row0:0:us║$0000000000000004 = Bye",
        "zone/z003/txtres:$row0:0:br║$0000000000000005 = Tchau",
      ].join("\n"),
      "utf8",
    );
    const format = new FFXFormat("PT");
    const read = await format.read_from_stream(original, "resources.strings");
    read.items[0]!.dst = "Olá, mundo";
    read.items[0]!.status = "PROCESSED";

    await format.write_to_path(
      read.items,
      { translated_path: dir.path, bilingual_path: dir.path },
      () => original,
    );

    const written = fs.readFileSync(path.join(dir.path, "resources.strings"), "utf8");
    expect(written).toContain(
      "/*key=part1/zone/z002/txtres row_count=1 version=2 source=us target=br*/",
    );
    expect(written).toContain("zone/z002/txtres:$row0:0:us║$0000000000000001 = Hello");
    expect(written).toContain("zone/z002/txtres:$row0:0:br║$0000000000000002 = Olá, mundo");
    expect(written).toContain("zone/z002/txtres:$row0:0:jp║$0000000000000003 = こんにちは");
    expect(written).not.toContain("║source = ");
    expect(written).not.toContain("║target = ");

    // Cada header acompanha o seu bloco: o segundo header vem antes das linhas dele.
    const secondHeader = written.indexOf("/*key=part1/zone/z003/txtres");
    expect(secondHeader).toBeGreaterThan(0);
    expect(written.slice(secondHeader)).toMatch(
      /^\/\*key=part1\/zone\/z003\/txtres row_count=1 version=2 source=us target=br\*\/\nzone\/z003\/txtres:\$row0:0:us/u,
    );
  });

  it("读取 FFX Strings v1 e preserva a projeção inline ao escrever", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-v1-"));
    const original = Buffer.from(
      [
        "/*key=battle row_count=1*/",
        "battle:0:us║$0000000000000001 = Potion║source = Potion║target = Poção",
        "battle:0:jp║$0000000000000002 = ポーション",
      ].join("\n"),
      "utf8",
    );
    const format = new FFXFormat("PT");
    const read = await format.read_from_stream(original, "resources.strings");

    expect(read.items).toHaveLength(1);
    expect(read.items[0]!.src).toBe("Potion");
    const extra = JSON.parse(String(read.items[0]!.extra_field));
    expect(extra.ffx_translations.us.target).toBe("Poção");

    await format.write_to_path(
      read.items,
      { translated_path: dir.path, bilingual_path: dir.path },
      () => original,
    );

    const written = fs.readFileSync(path.join(dir.path, "resources.strings"), "utf8");
    expect(written).toContain("/*key=battle row_count=1*/");
    expect(written).toContain(
      "battle:0:us║$0000000000000001 = Potion║source = Potion║target = Poção",
    );
    expect(written).toContain("battle:0:jp║$0000000000000002 = ポーション");
  });

  it("写回 FFX CSV 时保留公式样式与分隔符译文原文", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-csv-"));
    const original = Buffer.from(
      [
        "key,id,name,index,lang,hash,text,divergent",
        "menu,1,=SUM(A1:A2),0,us,$abc,=SUM(A1:A2),false",
        "menu,1,=SUM(A1:A2),0,pt,$def,=SUM(A1:A2),false",
      ].join("\n"),
      "utf8",
    );

    await new FFXFormat("PT").write_to_path(
      [
        create_item({
          src: "=SUM(A1:A2)",
          dst: "=SUM(A1:A2)",
          status: "PROCESSED",
          file_type: "FFX_CSV",
          file_path: "resources.csv",
          tag: "menu",
          extra_field: JSON.stringify({
            ffx_key: "menu",
            ffx_id: "1",
            ffx_name: "=SUM(A1:A2)",
            ffx_hash: "def",
            ffx_divergent: false,
            ffx_translations: { us: { text: "=SUM(A1:A2)", hash: "abc" } },
          }),
        }),
        create_item({
          src: "- Auto -",
          dst: "- Auto -",
          status: "PROCESSED",
          file_type: "FFX_CSV",
          file_path: "resources.csv",
          tag: "menu",
          row: 1,
          extra_field: JSON.stringify({
            ffx_key: "menu",
            ffx_id: "2",
            ffx_name: "- Auto -",
            ffx_hash: "def2",
            ffx_divergent: false,
            ffx_translations: { us: { text: "- Auto -", hash: "abc2" } },
          }),
        }),
      ],
      { translated_path: dir.path, bilingual_path: dir.path },
      () => original,
    );

    const written = fs.readFileSync(path.join(dir.path, "resources.csv"), "utf8");
    expect(written).toContain(",=SUM(A1:A2),");
    expect(written).toContain(",- Auto -,");
  });
});
