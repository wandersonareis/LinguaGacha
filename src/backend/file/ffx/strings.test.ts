import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { create_item } from "../../../domain/item";
import { read_ffx_strings, write_ffx_strings } from "./strings";

describe("FFX Strings v1/v2", () => {
  it("usa o source/target declarados no header do v2", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-lang-"));
    const content = [
      "/*key=zone/z001/txtres row_count=1 version=2 source=us target=fr*/",
      "zone/z001/txtres:0:us║$0000000000000001 = Hello",
      "zone/z001/txtres:0:fr║$0000000000000002 = Bonjour",
      "zone/z001/txtres:0:jp║$0000000000000003 = こんにちは",
    ].join("\n");
    const items = read_ffx_strings(content, "resources.strings");
    items[0]!.dst = "Salut";
    items[0]!.status = "PROCESSED";

    await write_ffx_strings(items, "resources.strings", dir.path);

    const written = fs.readFileSync(path.join(dir.path, "resources.strings"), "utf8");
    expect(written).toContain("/*key=zone/z001/txtres row_count=1 version=2 source=us target=fr*/");
    expect(written).toContain("zone/z001/txtres:0:us║$0000000000000001 = Hello");
    expect(written).toContain("zone/z001/txtres:0:fr║$0000000000000002 = Salut");
    expect(written).toContain("zone/z001/txtres:0:jp║$0000000000000003 = こんにちは");
    expect(written).not.toContain(":br║");
  });

  it("trata header sem version como v1", () => {
    const content = [
      "/*key=battle row_count=1*/",
      "battle:0:us║$0000000000000001 = Potion║source = Potion║target = Poção",
    ].join("\n");

    const items = read_ffx_strings(content, "resources.strings");

    expect(items).toHaveLength(1);
    expect(items[0]!.src).toBe("Potion");
    const extra = JSON.parse(String(items[0]!.extra_field));
    expect(extra.ffx_metadata.version).toBeUndefined();
    expect(extra.ffx_translations.us.target).toBe("Poção");
  });

  it("escreve arquivo novo (sem versão) como v1", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-new-"));
    const item = create_item({
      src: "Potion",
      dst: "Poção",
      status: "PROCESSED",
      file_type: "FFX_STRINGS",
      file_path: "new.strings",
      tag: "battle",
      row: 0,
      extra_field: JSON.stringify({
        ffx_key: "battle",
        ffx_translations: { us: { text: "Potion", hash: "0000000000000001" } },
      }),
    });

    await write_ffx_strings([item], "new.strings", dir.path);

    const written = fs.readFileSync(path.join(dir.path, "new.strings"), "utf8");
    expect(written).toContain("/*key=battle row_count=1*/");
    expect(written).not.toContain("version=");
    expect(written).toContain(
      "battle:0:us║$0000000000000001 = Potion║source = Potion║target = Poção",
    );
  });

  it("recusa blocos v1 quando o suporte está desligado", async () => {
    const v1 = [
      "/*key=battle row_count=1*/",
      "battle:0:us║$0000000000000001 = Potion║source = Potion║target = Poção",
    ].join("\n");

    expect(() => read_ffx_strings(v1, "old.strings", { allow_v1: false })).toThrow(
      /v1 desativado/u,
    );

    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-off-"));
    const items = read_ffx_strings(v1, "old.strings");
    await expect(
      write_ffx_strings(items, "old.strings", dir.path, { allow_v1: false }),
    ).rejects.toThrow(/v1 desativada/u);
  });

  it("recusa v2 sem source/target no header", () => {
    const content = [
      "/*key=zone/z001/txtres row_count=1 version=2*/",
      "zone/z001/txtres:0:us║$0000000000000001 = Hello",
    ].join("\n");

    expect(() => read_ffx_strings(content, "resources.strings")).toThrow(/v2 sem source\/target/u);
  });

  it("recusa versão de formato desconhecida", () => {
    const content = [
      "/*key=zone/z001/txtres row_count=1 version=3 source=us target=br*/",
      "zone/z001/txtres:0:us║$0000000000000001 = Hello",
    ].join("\n");

    expect(() => read_ffx_strings(content, "resources.strings")).toThrow(
      /versão de formato 3 não suportada/u,
    );
  });

  it("escreve cada bloco na sua versão", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-ffx-strings-mix-"));
    const content = [
      "/*key=a row_count=1*/",
      "a:0:us║$0000000000000001 = Old║source = Old║target = Velho",
      "/*key=b row_count=1 version=2 source=us target=br*/",
      "b:0:us║$0000000000000002 = New",
      "b:0:br║$0000000000000003 = Novo",
    ].join("\n");
    const items = read_ffx_strings(content, "resources.strings");

    await write_ffx_strings(items, "resources.strings", dir.path);

    const written = fs.readFileSync(path.join(dir.path, "resources.strings"), "utf8");
    expect(written).toContain("/*key=a row_count=1*/");
    expect(written).toContain("a:0:us║$0000000000000001 = Old║source = Old║target = Velho");
    expect(written).toContain("/*key=b row_count=1 version=2 source=us target=br*/");
    expect(written).toContain("b:0:us║$0000000000000002 = New");
    expect(written).toContain("b:0:br║$0000000000000003 = Novo");

    // Cada header precede as linhas do seu bloco.
    const firstHeader = written.indexOf("/*key=a row_count=1*/");
    const secondHeader = written.indexOf("/*key=b row_count=1 version=2");
    expect(firstHeader).toBeLessThan(written.indexOf("a:0:us"));
    expect(written.indexOf("a:0:us")).toBeLessThan(secondHeader);
    expect(secondHeader).toBeLessThan(written.indexOf("b:0:us"));
  });
});
