import { useAuth, useClerk, useUser } from "@clerk/react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  Building2Icon,
  GaugeIcon,
  LogInIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
  SmartphoneIcon,
  UserRoundIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNavigate } from "@tanstack/react-router";

import { activeCompanyIdAtom, companyListAtom } from "../../cloud/activeCompany";
import { hasClerkPublicConfig, hasCloudPublicConfig } from "../../cloud/publicConfig";
import {
  organizationCompanies,
  SETTINGS_PROFILE_SCOPE,
  settingsCompanyScopeAtom,
} from "../../cloud/settingsCompany";
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
import { CreateCompanyDialog } from "../settings/company/CreateCompanyDialog";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { usePathwayConnectAuthPrompt } from "./usePathwayConnectAuthPrompt";

const customProfilePageRoots = new WeakMap<HTMLDivElement, Root>();

export function shouldShowCompanyMenu(
  companies: ReadonlyArray<{ readonly workspaceKind: "personal" | "organization" }>,
): boolean {
  return companies.length > 0;
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
  const navigate = useNavigate();
  const companies = useAtomValue(companyListAtom);
  const companyChoices = organizationCompanies(companies);
  const [activeCompanyId, setActiveCompanyId] = useAtom(activeCompanyIdAtom);
  const [, setSettingsCompanyScope] = useAtom(settingsCompanyScopeAtom);
  const [createCompanyOpen, setCreateCompanyOpen] = useState(false);

  if (!isLoaded || !isSignedIn || !user) return null;

  const displayName = user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Your account";
  const emailAddress = user.primaryEmailAddress?.emailAddress;

  return (
    <>
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
                {companies.length > 1 ? (
                  <>
                    <DropdownMenuCheckboxItem
                      checked={activeCompanyId === null}
                      onCheckedChange={(checked) => {
                        if (!checked) return;
                        setActiveCompanyId(null);
                        setSettingsCompanyScope(SETTINGS_PROFILE_SCOPE);
                      }}
                    >
                      <Building2Icon />
                      <span>All companies</span>
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                {companyChoices.map((company) => (
                  <div className="relative" key={company.id}>
                    <DropdownMenuCheckboxItem
                      checked={company.id === activeCompanyId}
                      className="pe-9"
                      onCheckedChange={(checked) => {
                        if (!checked) return;
                        setActiveCompanyId(company.id);
                        setSettingsCompanyScope(company.id);
                      }}
                    >
                      <span className="block truncate">{company.name}</span>
                    </DropdownMenuCheckboxItem>
                    <button
                      type="button"
                      aria-label={`Open settings for ${company.name}`}
                      className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSettingsCompanyScope(company.id);
                        void navigate({ to: "/settings/company-members" });
                      }}
                    >
                      <SettingsIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
                {companyChoices.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setCreateCompanyOpen(true)}>
                  <PlusIcon />
                  <span>Create company</span>
                </DropdownMenuItem>
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
      {createCompanyOpen ? (
        <CreateCompanyDialog
          open
          onOpenChange={setCreateCompanyOpen}
          onCreated={(company) => {
            setSettingsCompanyScope(company.id);
            void navigate({ to: "/settings/company-members" });
          }}
        />
      ) : null}
    </>
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
