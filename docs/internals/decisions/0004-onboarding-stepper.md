# 0004 — Blocking, resumable onboarding stepper

Status: Accepted
Date: 2026-08-11

## Context

With accounts mandatory ([0001](0001-mandatory-account-gate.md)), a freshly registered user is
authenticated but has no profile. That is a third state the auth gate does not model:
`resolveClerkAuthGateState` in `apps/web/src/components/clerk/authGate.logic.ts` returns
`authenticated | loading | public | redirect`, and treats "signed in" as "let them in".

The name is already taken. `apps/web/src/components/cloud/ConnectOnboardingDialog.tsx` is a
post-sign-in wizard with its own `OnboardingStep = "publish" | "devices"` and a localStorage
opt-out, and it fires on every in-session sign-in. Two onboarding surfaces would otherwise
compete on first launch.

The data model is a sum type, not a struct. The user first picks whether they are an individual
or part of a company, and the remaining questions differ by branch.

## Decision

Onboarding is a blocking, resumable stepper at `/onboarding`, reached after email verification
and before the app.

**Gate.** `resolveClerkAuthGateState` gains an `onboarding` state, derived from
`unsafeMetadata.onboardingCompletedAt` being absent. `/onboarding` joins `/login` as a route
reachable without a completed profile. A signed-in user with a completed profile who navigates to
`/onboarding` is redirected out, matching how `/login` already bounces signed-in users.

**Steps.**

1. **Identity.** Display name, optional avatar.
2. **Account kind.** Two side-by-side selection cards — Individual or Company — each spanning half
   a twelve-column grid, stacking on narrow viewports. React Native uses the flex equivalent;
   there is no CSS grid there.
3. **Branch.**
   - _Company_: company name, company size bucket, role. Then the domain auto-join offer from
     [0005](0005-company-via-clerk-organizations.md).
   - _Individual_: which providers you use today (Codex, Claude, Cursor, Grok, OpenCode — the
     adapters that exist), and how you heard about us.

Only the display name is required. Avatar, company detail, and the survey questions are skippable
with a visible control.

**Resumability.** Step state is written to `unsafeMetadata` as it is completed, not batched at the
end, so a refresh, crash, or device switch resumes in place. Because the state is on the Clerk
user, resumption crosses devices for free ([0003](0003-profile-in-clerk-user.md)).

**Ordering against T3 Connect.** `ConnectOnboardingDialog` must not render while the profile
stepper is incomplete. The gate handles this naturally — the dialog lives inside the authenticated
shell, which an onboarding user never reaches — but the ordering is a requirement, not an
accident, and is why the stepper is a route rather than another dialog.

## Consequences

- The progress indicator cannot be a fixed "step 2 of 4" before the branch is chosen. Either
  render progress only after step 2, or ensure both branches have equal length.
- "Which providers do you use" is answerable as setup rather than as a survey: it can seed
  first-run provider configuration. A question that changes the product is worth asking; one that
  only feeds a chart is not.
- Every question is a place to abandon. The required set is deliberately one field.
- Mobile ships in the same release: a separate Expo stack, plus `expo-image-picker` and its
  permission prompts for the avatar, plus an app-store review cycle on the critical path.
- Adding a step later is a metadata-shape change on a user population that has already onboarded.
  Version the metadata and treat an unknown version as "needs the new step".

## Alternatives rejected

- **All steps required.** Maximum capture, maximum abandonment, and the first thing a new user
  sees is a demand for their company.
- **Non-blocking dismissible prompt.** Best activation, but it puts a second dismissible
  onboarding surface next to `ConnectOnboardingDialog` on first launch.
