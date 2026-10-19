import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fillBrowserLoginFields } from "./browserPasswordAutofill.ts";

class Form extends EventTarget {
  fields: Input[] = [];
  submit = vi.fn();
  querySelectorAll() {
    return this.fields;
  }
}
class Input extends EventTarget {
  disabled = false;
  readOnly = false;
  type = "text";
  autocomplete = "";
  name = "";
  id = "";
  form: Form | null = null;
  visible = true;
  position = 0;
  storedValue = "";
  get value() {
    return this.storedValue;
  }
  set value(value: string) {
    this.storedValue = value;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  compareDocumentPosition(other: Input) {
    return this.position < other.position ? 4 : 2;
  }
}
const login = {
  origin: "https://example.com",
  username: "test-user",
  password: "private-test-password",
};
function dom(fields: Partial<Input>[]) {
  const form = new Form();
  const inputs = fields.map((fields, position) =>
    Object.assign(new Input(), { position, form }, fields),
  );
  form.fields = inputs;
  vi.stubGlobal("location", { origin: login.origin });
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) =>
      selector.includes("password") ? inputs.filter((field) => field.type === "password") : inputs,
  });
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("Node", { DOCUMENT_POSITION_FOLLOWING: 4 });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block" }));
  return { inputs, form };
}
afterEach(() => vi.unstubAllGlobals());
describe("saved-login DOM fill", () => {
  it("checks the live origin before reading or changing any fields", () => {
    const { inputs } = dom([{ name: "username" }, { type: "password" }]);
    expect(fillBrowserLoginFields({ ...login, origin: "https://different.example" })).toBe(
      "origin",
    );
    expect(inputs.map((field) => field.value)).toEqual(["", ""]);
  });
  it("fills the same-form username with native setters and bubbling events without submitting", () => {
    const { inputs, form } = dom([
      { name: "email", form: new Form() },
      { autocomplete: "username" },
      { type: "password" },
    ]);
    form.fields = inputs.slice(1);
    const events: string[] = [];
    for (const field of inputs) {
      field.addEventListener("input", (event) =>
        events.push(`${field.position}:input:${event.bubbles}`),
      );
      field.addEventListener("change", (event) =>
        events.push(`${field.position}:change:${event.bubbles}`),
      );
    }
    const overriddenSetter = vi.fn();
    Object.defineProperty(inputs[1]!, "value", { set: overriddenSetter });
    expect(fillBrowserLoginFields(login)).toBe("filled");
    expect(inputs.map((field) => field.storedValue)).toEqual(["", login.username, login.password]);
    expect(overriddenSetter).not.toHaveBeenCalled();
    expect(events).toEqual(["1:input:true", "1:change:true", "2:input:true", "2:change:true"]);
    expect(form.submit).not.toHaveBeenCalled();
  });
  it.each([
    [{ type: "password" }, { type: "password" }],
    [{ type: "password", autocomplete: "new-password" }],
    [{ name: "username" }, { name: "login" }, { type: "password" }],
    [{ name: "username" }],
  ])("rejects ambiguous or registration forms without partial fills", (...fields) => {
    const { inputs } = dom(fields);
    expect(fillBrowserLoginFields(login)).toBe("ambiguous");
    expect(inputs.every((field) => field.value === "")).toBe(true);
  });
  it("ignores hidden, disabled, and readonly password fields", () => {
    const { inputs } = dom([
      { type: "password", visible: false },
      { type: "password", disabled: true },
      { type: "password", readOnly: true },
      { type: "password" },
    ]);
    expect(fillBrowserLoginFields(login)).toBe("filled");
    expect(inputs.map((field) => field.value)).toEqual(["", "", "", login.password]);
  });
});
