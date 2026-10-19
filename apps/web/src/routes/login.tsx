import { useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "../components/auth/AuthShell";
import { SignInForm } from "../components/auth/SignInForm";
import { hasClerkPublicConfig } from "../cloud/publicConfig";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  if (!hasClerkPublicConfig()) return <Navigate replace to="/" />;

  return <ConfiguredLoginPage />;
}

function ConfiguredLoginPage() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });

  if (isLoaded && isSignedIn) return <Navigate replace to="/" />;

  return (
    <AuthShell>
      <SignInForm />
    </AuthShell>
  );
}
