import { useAuth, useClerk, useUser } from "@clerk/react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  Building2Icon,
  GaugeIcon,
  LogInIcon,
  LogOutIcon,
  SmartphoneIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { activeCompanyIdAtom, companyListAtom } from "../../cloud/activeCompany";
import { hasClerkPublicConfig, hasCloudPublicConfig } from "../../cloud/publicConfig";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/menu";
import { ConnectedProviderUsageMenu } from "../usage/ProviderUsage";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { usePathwayConnectAuthPrompt } from "./usePathwayConnectAuthPrompt";

const customProfilePageRoots = new WeakMap<HTMLDivElement, Root>();

export function shouldShowCompanyMenu(
  companies: ReadonlyArray<{ readonly workspaceKind: "personal" | "organization" }>,
): boolean {
  return companies.some((company) => company.workspaceKind === "organization");
}

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

export function PathwayConnectSidebarSignIn() {
  if (!hasClerkPublicConfig()) return null;

  return <ConfiguredPathwayConnectSidebarSignIn />;
}

export function PathwayConnectProfileButton() {
  if (!hasClerkPublicConfig()) return null;

  return <ConfiguredPathwayConnectProfileButton />;
}

function ConfiguredPathwayConnectProfileButton() {
  const { openUserProfile, signOut } = useClerk();
  const { isLoaded, isSignedIn, user } = useUser();
  const companies = useAtomValue(companyListAtom);
  const [activeCompanyId, setActiveCompanyId] = useAtom(activeCompanyIdAtom);

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
        {shouldShowCompanyMenu(companies) ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Building2Icon />
              <span>Company</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {companies.map((company) => (
                <DropdownMenuCheckboxItem
                  checked={company.id === activeCompanyId}
                  key={company.id}
                  onCheckedChange={(checked) => {
                    if (checked) setActiveCompanyId(company.id);
                  }}
                >
                  {company.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <GaugeIcon />
            <span>Provider usage</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-80">
            <ConnectedProviderUsageMenu />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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

function ConfiguredPathwayConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = usePathwayConnectAuthPrompt();

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
