// Test: the JSON response body is read as any so assertions need no per-call cast.
export {};
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
