# 0002 — First-party sign-in and registration UI

Status: Accepted
Date: 2026-08-11

## Context

`apps/web/src/routes/login.tsx` renders Clerk's `<SignIn />` with an `appearance` override mapping
Clerk variables onto our CSS custom properties. It looks close to the product, but it is Clerk's
markup, Clerk's layout, and Clerk's copy. There is no registration surface at all.

The Clerk instance backing this fork is new and has no production accounts, so no existing user
depends on a strategy we choose not to build. That is the fact that makes a narrow first-party
form safe here and would not make it safe against an established instance.

## Decision

Build our own sign-in and registration forms against Clerk's headless hooks (`useSignIn`,
`useSignUp`), replacing `<SignIn />`. Email and password is the only supported strategy.

In scope for the first release:

- Sign in with email + password.
- Register with email + password, followed by email verification via a 6-digit code
  (`prepareEmailAddressVerification` → `attemptEmailAddressVerification`) with a resend control on
  a cooldown.
- Password reset (`strategy: "reset_password_email_code"`), shipped in the same change as sign-in.
- Clerk bot protection: the CAPTCHA element must be mounted or `signUp.create()` fails.

Out of scope: OAuth providers, passkeys, MFA.

Web, desktop, and mobile ship together. Desktop inherits the web implementation through
`apps/desktop`; mobile reimplements the same flow against `@clerk/expo` in its own navigation
stack.

## Consequences

- Every state Clerk's component handled for free is now ours: wrong password, unknown identifier,
  unverified email, rate limiting, lockout, expired verification code, and network failure. The
  error taxonomy is the bulk of the work, not the layout.
- Dropping passkeys means `@clerk/electron-passkeys` becomes an unused dependency on desktop.
  Resolution: it stays installed and wired at the provider (`apps/web/src/main.tsx`,
  `apps/desktop/src/preload.ts`) but is deliberately dormant — no form invokes it. It is kept
  because the provider wiring is the expensive part to rebuild and passkeys are a likely
  follow-up; the sign-in form must gain a passkey button before it does anything. Do not remove
  the wiring without reading this record.
- Adding OAuth later is additive (`authenticateWithRedirect` plus an SSO callback route), but on
  desktop it must route through the `pathway://` deep link already handled in
  `apps/web/src/components/clerk/authRedirect.ts`.
- Registration must not silently fail. Bot protection failing without a mounted CAPTCHA looks like
  a dead submit button.

## Alternatives rejected

- **Keep `<SignIn />`, restyle harder.** Cheapest and most robust, but the appearance API cannot
  reach the layout and copy this product wants.
- **Custom form, Clerk component as fallback on desktop.** Two login UIs to maintain on the
  surface most users start on.
