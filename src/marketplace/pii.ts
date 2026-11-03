// Scan of the preview of a dataset for personal data (BE-056, ADR-46 point 5). A preview is shown before the purchase, so one that holds an email address, an identity number,
// a phone number or a card number is refused. The scan returns the KINDS it found, never the matches (the backend must not log or echo personal data). It is a safety net with
// the usual limits of patterns: it finds the common shapes, not every personal datum.
export type PiiKind = "email" | "nik" | "phone" | "card" | "us_ssn" | "iban";

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/** An Indonesian NIK: 16 digits, province 11 to 94, day 01 to 31 (or 41 to 71 for women), month 01 to 12. */
const nik = (digits: string): boolean => {
  const province = Number(digits.slice(0, 2));
  let day = Number(digits.slice(6, 8));
  const month = Number(digits.slice(8, 10));
  if (day > 40) day -= 40;
  return province >= 11 && province <= 94 && day >= 1 && day <= 31 && month >= 1 && month <= 12;
};

export function scanPii(text: string): PiiKind[] {
  const found = new Set<PiiKind>();
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(text)) found.add("email");
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) found.add("us_ssn");
  if (/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/.test(text)) found.add("iban");
  // runs of digits, allowing single spaces or dashes between groups
  for (const m of text.matchAll(/(?<![\w.])\d(?:[ -]?\d){12,18}(?![\w])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length === 16 && nik(digits)) found.add("nik");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add("card");
  }
  // phone numbers: +CC with 8 to 13 digits, or an Indonesian 08xx number
  if (/(?<![\w])\+\d{1,3}[ -]?\(?\d{2,4}\)?(?:[ -]?\d{2,5}){2,4}(?!\d)/.test(text) || /(?<![\w])0[89]\d{2}[ -]?\d{3,4}[ -]?\d{2,5}(?!\d)/.test(text)) found.add("phone");
  return [...found];
}
