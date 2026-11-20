import { describe, expect, it } from "vitest";
import {
  build_project_file_name,
  is_project_name_valid,
  normalize_project_name,
} from "./project-file-name";

describe("normalize_project_name", () => {
  it("去除首尾空白与重复的 .lg 后缀", () => {
    expect(normalize_project_name("  Meu Projeto  ")).toBe("Meu Projeto");
    expect(normalize_project_name("Meu Projeto.lg")).toBe("Meu Projeto");
    expect(normalize_project_name("Meu Projeto.LG")).toBe("Meu Projeto");
    expect(normalize_project_name("Meu Projeto.lg ")).toBe("Meu Projeto");
  });

  it("只去掉一个末尾扩展名，保留名称中的其它点号", () => {
    expect(normalize_project_name("Game.v1.2")).toBe("Game.v1.2");
    expect(normalize_project_name("Game.v1.2.lg")).toBe("Game.v1.2");
  });
});

describe("is_project_name_valid", () => {
  it.each(["", "Meu Projeto", "Game.v1.2", "翻译项目"])("接受名称 %j", (value) => {
    expect(is_project_name_valid(value)).toBe(true);
  });

  it.each(["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\u0000b"])(
    "拒绝路径分隔符与保留字符 %j",
    (value) => {
      expect(is_project_name_valid(value)).toBe(false);
    },
  );

  it.each(["nome.", "nome "])("拒绝末尾点号或空格 %j", (value) => {
    expect(is_project_name_valid(value)).toBe(false);
  });

  it.each(["CON", "con", "NUL.txt", "COM1", "LPT9.dados"])("拒绝 Windows 保留名称 %j", (value) => {
    expect(is_project_name_valid(value)).toBe(false);
  });
});

describe("build_project_file_name", () => {
  it("用户名称优先并补上 .lg", () => {
    expect(build_project_file_name("Meu Projeto", "fallback")).toBe("Meu Projeto.lg");
    expect(build_project_file_name("Meu Projeto.lg", "fallback")).toBe("Meu Projeto.lg");
  });

  it("留空时使用默认名称", () => {
    expect(build_project_file_name("", "lg_project_20251120_153701")).toBe(
      "lg_project_20251120_153701.lg",
    );
    expect(build_project_file_name("   ", "fallback")).toBe("fallback.lg");
  });
});
