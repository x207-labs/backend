import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
type Scan = { WORDS: RegExp; stringLiterals: (src: string) => Array<{ line: number; text: string }>; markdownLines: (src: string) => Array<{ line: number; text: string }>; walk: (dir: string, files?: string[], ext?: string) => string[] };
const load = async (): Promise<Scan> => (await import(String("../../scripts/scan-language.mjs"))) as Scan;

describe("BE-075 every message to a user or an operator is English", () => {
  it("TC-BE-075-01 no string literal of src/ or broker/src/ holds a common Indonesian word (comments are not looked at)", async () => {
    const { WORDS, stringLiterals, walk } = await load();
    const hits: string[] = [];
    for (const dir of ["src", "broker/src"]) {
      for (const file of walk(join(ROOT, dir))) {
        for (const s of stringLiterals(readFileSync(file, "utf8"))) if (WORDS.test(s.text)) hits.push(`${file.slice(ROOT.length)}:${s.line}  ${s.text.slice(0, 80)}`);
      }
    }
    expect(hits, "Indonesian in a string: translate it (BE-075)").toEqual([]);
  });

  it("TC-BE-076-01 no line of a Markdown document of the backend or the broker holds a common Indonesian word (code fence info strings are not prose)", async () => {
    const { WORDS, markdownLines, walk } = await load();
    const hits: string[] = [];
    const files = [join(ROOT, "README.md"), join(ROOT, "broker/README.md"), ...walk(join(ROOT, "docs"), [], ".md")];
    for (const file of files) {
      for (const s of markdownLines(readFileSync(file, "utf8"))) if (WORDS.test(s.text)) hits.push(`${file.slice(ROOT.length)}:${s.line}  ${s.text.slice(0, 80)}`);
    }
    expect(hits, "Indonesian in a document: translate it (BE-076)").toEqual([]);
  });

  it("TC-BE-076-02 the Markdown scan reads prose and tables, and skips the info string of a code fence", async () => {
    const { WORDS, markdownLines } = await load();
    const hit = (src: string): boolean => markdownLines(src).some((s) => WORDS.test(s.text));
    expect(hit("| Folder | Isi |\n|---|---|")).toBe(true);
    expect(hit("Konfigurasi lewat `.env` dan tidak di-commit.")).toBe(true);
    expect(hit("```ini\n[Unit]\n```")).toBe(false);
    expect(hit("# Settlement worker\n\nThe worker holds no key.")).toBe(false);
  });

  it("TC-BE-075-02 the scanner finds Indonesian in strings and templates, and leaves comments, English and code alone", async () => {
    const { WORDS, stringLiterals } = await load();
    const hit = (src: string): boolean => stringLiterals(src).some((s) => WORDS.test(s.text));
    expect(hit('throw new Error("Penawaran dengan hash ini sudah tercatat");')).toBe(true);
    expect(hit("const m = `Akun ${a} tidak ada`;")).toBe(true);
    expect(hit("const m = `${a} dan ${`kode salah`}`;")).toBe(true);
    expect(hit('invalidRequest("Redirect tidak diikuti")')).toBe(true);
    expect(hit("// pesan ini harus diganti\nconst x = 1;")).toBe(false);
    expect(hit("/* dengan yang tidak */ const x = 1;")).toBe(false);
    expect(hit('throw new Error("Offer with this hash is already recorded");')).toBe(false);
    expect(hit("const re = /dengan|yang/; const s = 'ok';")).toBe(false);
  });
});
