import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@clerk/react/legacy", () => ({
  useSignIn: () => ({ isLoaded: true, setActive: vi.fn(), signIn: {} }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => <a href="/register">{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { SignInForm } from "./SignInForm";

describe("SignInForm", () => {
  it("puts the password directly after email in the native tab order", () => {
    const markup = renderToStaticMarkup(<SignInForm />);
    const email = markup.indexOf('id="sign-in-email"');
    const password = markup.indexOf('id="sign-in-password"');
    const forgotPassword = markup.indexOf("Forgot password?");

    expect(email).toBeGreaterThan(-1);
    expect(password).toBeGreaterThan(email);
    expect(forgotPassword).toBeGreaterThan(password);
  });
});
