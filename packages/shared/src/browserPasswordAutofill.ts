/** Runs entirely inside the page; the origin check and fill share one synchronous execution. */
export function fillBrowserLoginFields(input: {
  origin: string;
  username: string;
  password: string;
}): "filled" | "origin" | "ambiguous" {
  interface FieldContainer {
    querySelectorAll(selector: string): ArrayLike<InputField>;
  }
  interface InputField {
    disabled: boolean;
    readOnly: boolean;
    type: string;
    autocomplete: string;
    name: string;
    id: string;
    form: FieldContainer | null;
    getClientRects(): ArrayLike<unknown>;
    compareDocumentPosition(other: InputField): number;
    dispatchEvent(event: unknown): boolean;
  }
  const { location, document, getComputedStyle, HTMLInputElement, Node, Event } =
    globalThis as unknown as {
      location: { origin: string };
      document: FieldContainer;
      getComputedStyle(field: InputField): { visibility: string; display: string };
      HTMLInputElement: { prototype: object };
      Node: { DOCUMENT_POSITION_FOLLOWING: number };
      Event: new (type: string, options: { bubbles: boolean }) => unknown;
    };
  if (location.origin !== input.origin) return "origin";
  const visible = (field: InputField) => {
    const style = getComputedStyle(field);
    return (
      !field.disabled &&
      !field.readOnly &&
      field.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
  if (passwords.length !== 1) return "ambiguous";
  const password = passwords[0]!;
  if (password.autocomplete.split(/\s+/).includes("new-password")) return "ambiguous";
  const candidates = Array.from((password.form ?? document).querySelectorAll("input"))
    .filter(
      (field) =>
        visible(field) &&
        ["text", "email"].includes(field.type) &&
        Boolean(field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING),
    )
    .map((field) => ({
      field,
      score: field.autocomplete.split(/\s+/).includes("username")
        ? 3
        : field.type === "email"
          ? 2
          : /user|email|login/i.test(field.name + " " + field.id)
            ? 1
            : 0,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return "ambiguous";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return "ambiguous";
  const fill = (field: InputField, value: string) => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (input.username && candidates[0]) fill(candidates[0].field, input.username);
  fill(password, input.password);
  return "filled";
}
