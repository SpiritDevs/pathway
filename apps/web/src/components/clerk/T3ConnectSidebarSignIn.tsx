import { useAuth, useClerk, useUser } from "@clerk/react";
import { LogInIcon, LogOutIcon, SmartphoneIcon, UserRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { hasClerkPublicConfig, hasCloudPublicConfig } from "../../cloud/publicConfig";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

const customProfilePageRoots = new WeakMap<HTMLDivElement, Root>();

function mountCustomProfilePage(element: HTMLDivElement, content: ReactNode) {
  const root = createRoot(element);
  customProfilePageRoots.set(element, root);
  root.render(content);
}

function unmountCustomProfilePage(element?: HTMLDivElement) {
  if (!element) return;
  customProfilePageRoots.get(element)?.unmount();
  customProfilePageRoots.delete(element);
}

const MOBILE_CLIENTS_PROFILE_PAGE = {
  label: "Mobile clients",
  url: "mobile-clients",
  mountIcon: (element: HTMLDivElement) =>
    mountCustomProfilePage(element, <SmartphoneIcon className="size-4" />),
  unmountIcon: unmountCustomProfilePage,
  mount: (element: HTMLDivElement) =>
    mountCustomProfilePage(element, <MobileClientsUserProfilePage />),
  unmount: unmountCustomProfilePage,
};

export function T3ConnectSidebarSignIn() {
  if (!hasClerkPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectProfileButton() {
  if (!hasClerkPublicConfig()) return null;

  return <ConfiguredT3ConnectProfileButton />;
}

function ConfiguredT3ConnectProfileButton() {
  const { openUserProfile, signOut } = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded || !isSignedIn || !user) return null;

  const displayName = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Your account";
  const emailAddress = user.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Open profile menu for ${displayName}`}
        className="rounded-lg p-1 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-row-hover"
      >
        <img
          alt={`${displayName}'s profile image`}
          className="size-7 rounded-full object-cover"
          crossOrigin="anonymous"
          src={user.imageUrl}
          title={displayName}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" sideOffset={6}>
        <div className="flex min-w-0 items-center gap-3 px-2 py-2">
          <img
            alt=""
            aria-hidden="true"
            className="size-9 shrink-0 rounded-full object-cover"
            crossOrigin="anonymous"
            src={user.imageUrl}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            {emailAddress ? (
              <p className="truncate text-xs text-muted-foreground">{emailAddress}</p>
            ) : null}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            openUserProfile(
              hasCloudPublicConfig() ? { customPages: [MOBILE_CLIENTS_PROFILE_PAGE] } : {},
            )
          }
        >
          <UserRoundIcon />
          <span>Manage account</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
