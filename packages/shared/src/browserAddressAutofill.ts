/**
 * Runs entirely inside the page: fills the visible address form fields it can
 * identify with a saved address. Returns how many fields it filled.
 */
export function fillBrowserAddressFields(input: {
  fullName: string;
  organization: string;
  streetAddress: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
}): number {
  interface Field {
    disabled: boolean;
    readOnly?: boolean;
    type: string;
    tagName: string;
    autocomplete: string;
    name: string;
    id: string;
    value: string;
    labels: ArrayLike<{ textContent: string | null }> | null;
    options?: ArrayLike<{ value: string; textContent: string | null }>;
    getAttribute(name: string): string | null;
    getClientRects(): ArrayLike<unknown>;
    dispatchEvent(event: unknown): boolean;
  }
  const {
    document,
    getComputedStyle,
    HTMLInputElement,
    HTMLSelectElement,
    HTMLTextAreaElement,
    Event,
  } = globalThis as unknown as {
    document: { querySelectorAll(selector: string): ArrayLike<Field> };
    getComputedStyle(field: Field): { visibility: string; display: string };
    HTMLInputElement: { prototype: object };
    HTMLSelectElement: { prototype: object };
    HTMLTextAreaElement: { prototype: object };
    Event: new (type: string, options: { bubbles: boolean }) => unknown;
  };
  const [givenName, ...familyNames] = input.fullName.trim().split(/\s+/);
  const lines = input.streetAddress.split(/\r?\n/);
  const values: Record<string, string> = {
    name: input.fullName,
    "given-name": givenName ?? "",
    "family-name": familyNames.join(" "),
    organization: input.organization,
    "street-address": input.streetAddress,
    "address-line1": lines[0] ?? "",
    "address-line2": lines.slice(1).join(", "),
    "address-level2": input.city,
    "address-level1": input.region,
    "postal-code": input.postalCode,
    country: input.country,
    "country-name": input.country,
    tel: input.phone,
    email: input.email,
  };
  // Fallbacks for fields without autocomplete tokens, tried against name, id, and label.
  const guesses: ReadonlyArray<readonly [RegExp, string]> = [
    [/e-?mail/i, "email"],
    [/phone|tel|mobile/i, "tel"],
    [/first.?name|given/i, "given-name"],
    [/last.?name|surname|family/i, "family-name"],
    [/full.?name|^name$|your.?name/i, "name"],
    [/company|organi[sz]ation|business/i, "organization"],
    [/address.?(line)?.?2|apt|suite|unit/i, "address-line2"],
    [/street|address/i, "address-line1"],
    [/city|town|suburb|locality/i, "address-level2"],
    [/state|province|region|county/i, "address-level1"],
    [/zip|postal|postcode/i, "postal-code"],
    [/country/i, "country"],
  ];
  const visible = (field: Field) => {
    const style = getComputedStyle(field);
    return (
      !field.disabled &&
      !field.readOnly &&
      field.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const kindOf = (field: Field): string | null => {
    const tokens = field.autocomplete.toLowerCase().split(/\s+/);
    const token = tokens.find((entry) => entry in values);
    if (token) return token;
    if (field.type === "email") return "email";
    if (field.type === "tel") return "tel";
    const label = Array.from(field.labels ?? [], (entry) => entry.textContent ?? "").join(" ");
    const haystack = [field.name, field.id, field.getAttribute("placeholder") ?? "", label].join(
      " ",
    );
    return guesses.find(([pattern]) => pattern.test(haystack))?.[1] ?? null;
  };
  const setterOf = (prototype: object) => Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  const setters: Record<string, ((this: unknown, value: string) => void) | undefined> = {
    INPUT: setterOf(HTMLInputElement.prototype),
    SELECT: setterOf(HTMLSelectElement.prototype),
    TEXTAREA: setterOf(HTMLTextAreaElement.prototype),
  };
  let filled = 0;
  const fields = Array.from(
    document.querySelectorAll(
      'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="search"], select, textarea',
    ),
  ).filter(visible);
  for (const field of fields) {
    const kind = kindOf(field);
    const value = kind ? values[kind] : undefined;
    const setter = setters[field.tagName];
    if (!value || !setter || field.value !== "") continue;
    let next = value;
    if (field.tagName === "SELECT") {
      const wanted = value.trim().toLowerCase();
      const option = Array.from(field.options ?? []).find(
        (entry) =>
          entry.value.toLowerCase() === wanted ||
          (entry.textContent ?? "").trim().toLowerCase() === wanted,
      );
      if (!option) continue;
      next = option.value;
    }
    setter.call(field, next);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    filled += 1;
  }
  return filled;
}
