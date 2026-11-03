// BE-075: lists the string literals (not comments) of TypeScript files that contain common Indonesian words, so that every message to a user or an operator is English.
//   node scripts/scan-language.mjs <file or folder>
// Own lexer: no TypeScript API needed. `test/ops/language.test.ts` runs it over src/ and broker/src/ and fails on any hit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const WORDS = /\b(dengan|yang|tidak|untuk|dari|sudah|belum|harus|bukan|atau|adalah|akan|pada|ini|itu|karena|setelah|sebelum|tanpa|jangan|wajib|salah|gagal|ditolak|tercatat|pembeli|penjual|pesanan|tonggak|lingkaran|anggota|dikenal|oleh|bisa|hanya|semua|lebih|masih|akun|jawaban|permintaan|kosong|terlalu|lewat|menyimpang|berbeda|dibatalkan|dikonfirmasi|menunggu|tertinggal|dicek|diperiksa|cocok|memuat|memakai|dipakai|diisi|pilih|isi|kunci|kode|tidak|penyedia|penerbit|sewa|bayar|dibayar|tagihan|pemberi|penyewa|saldo|jumlah|nilai|harga|waktu|detik|menit|jam|hari|epoch ini|blok|listing ini|pemilik|lagi|coba|ulang|boleh|mohon|berikut|tersebut|secara|serta|juga|namun|jika|bila|maka|agar|supaya|sampai|selama|sedang|telah|pernah|belum|tengah|ditemukan|kirim|tunggu|lalu|selesai|tulis|baca|panggil|buat|simpan|ambil|tarik|setor|jalur|masuk|keluar|pakai|sebagai|antara|berisi|tepat|melebihi|melewati|lewati|ditahan|dilepas|lepas|dua|satu|tiga|baru|lama|lalu|sekarang|nanti|dulu|kemudian|akhir|awal|sisa|kurang|banyak|sedikit|ganti|ubah|hapus|tambah|kurangi|naik|turun|buka|tutup|ditutup|dibuka|diterima|menerima|menolak|ditandatangani|tanda tangan|jangan|kembali|mengembalikan|dikembalikan|mengirim|dikirim|bayar|membayar|pembayaran|melunasi|lunas|utang|hutang|piutang|jaminan|sengketa|keluhan|aduan|kedaluwarsa|berlaku|mengikat|mencatat|dicatat|catatan|ketika|apabila|walau|meski|sehingga|demi|bagi|kepada|terhadap|tentang|antar|ke akun|di akun|dalam|luar|atas|bawah|depan|belakang)\b/i;

export function stringLiterals(src) {
  const out = [];
  let i = 0;
  let prev = "";
  const line = (pos) => src.slice(0, pos).split("\n").length;
  const stack = []; // template nesting: number of open { inside ${ }
  const readTemplate = () => {
    // i is after the opening ` or after the closing } of a ${ }
    let start = i;
    let text = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { text += src[i + 1] ?? ""; i += 2; continue; }
      if (c === "`") { out.push({ at: start, text }); i += 1; return "end"; }
      if (c === "$" && src[i + 1] === "{") { out.push({ at: start, text }); i += 2; return "expr"; }
      text += c; i += 1;
    }
    return "end";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; const start = i; i++; let text = "";
      while (i < src.length && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") { text += src[i + 1] ?? ""; i += 2; } else { text += src[i]; i++; } }
      out.push({ at: start, text }); i++; prev = q; continue;
    }
    if (c === "`") { i++; const r = readTemplate(); if (r === "expr") stack.push(0); prev = "`"; continue; }
    if (stack.length > 0) {
      if (c === "{") { stack[stack.length - 1]++; }
      else if (c === "}") {
        if (stack[stack.length - 1] === 0) { stack.pop(); i++; const r = readTemplate(); if (r === "expr") stack.push(0); continue; }
        stack[stack.length - 1]--;
      }
    }
    if (c === "/" && /[(,=:\[!&|?{};]|^$|return|typeof/.test(prev)) {
      // a regular expression literal
      i++; let inClass = false;
      while (i < src.length && src[i] !== "\n") { if (src[i] === "\\") i += 2; else { if (src[i] === "[") inClass = true; else if (src[i] === "]") inClass = false; else if (src[i] === "/" && !inClass) break; i++; } }
      i++; while (/[a-z]/.test(src[i] ?? "")) i++; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = /[A-Za-z0-9_$]/.test(c) ? (src.slice(Math.max(0, i - 6), i + 1).match(/(return|typeof)$/)?.[0] ?? "a") : c;
    i++;
  }
  return out.map((o) => ({ line: line(o.at), text: o.text }));
}

export function walk(dir, files = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (p.endsWith(".ts")) files.push(p);
  }
  return files;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let n = 0;
  const target = process.argv[2];
  for (const f of statSync(target).isDirectory() ? walk(target) : [target]) {
    for (const s of stringLiterals(readFileSync(f, "utf8"))) if (WORDS.test(s.text)) { n++; console.log(`${f}:${s.line}\t${s.text.replace(/\n/g, "\\n").slice(0, 220)}`); }
  }
  console.error(n, "literals");
}
