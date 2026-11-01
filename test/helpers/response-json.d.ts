// Test: body JSON respons dibaca sebagai any agar assertion tidak perlu cast satu per satu.
export {};
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
