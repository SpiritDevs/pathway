import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  Building2Icon,
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  CircleDotIcon,
  FileUpIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  FolderIcon,
  GitBranchIcon,
  KeyboardIcon,
  MailIcon,
  MilestoneIcon,
  PaletteIcon,
  PlugZapIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  TagsIcon,
  ShieldIcon,
  UserRoundIcon,
  UsersIcon,
  UsersRoundIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { PathwayConnectSidebarSignIn } from "../clerk/PathwayConnectSidebarSignIn";
import { useCompanySettings } from "./company/useCompanySettings";
import { permissionGate } from "./company/companySettings.logic";
import { useCompanyIntegrationsClient } from "~/cloud/useCompanyIntegrationsClient";
import { SETTINGS_AUTO_SCOPE, SETTINGS_PROFILE_SCOPE } from "~/cloud/settingsCompany";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  settingsPathIsVisibleForWorkspace,
  settingsSectionPathForSearchPath,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchPath,
  type SettingsSearchItem,
} from "./settingsSearch";

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/projects": FolderIcon,
  "/settings/members-teams": UsersIcon,
  "/settings/company-members": UserRoundIcon,
  "/settings/company-teams": UsersRoundIcon,
  "/settings/company-roles": ShieldIcon,
  "/settings/calendars": CalendarDaysIcon,
  "/settings/environments": ServerIcon,
  "/settings/integrations": PlugZapIcon,
  "/settings/providers": BotIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/usage": ChartNoAxesColumnIcon,
  "/settings/issues-statuses": CircleDotIcon,
  "/settings/issues-labels": TagsIcon,
  "/settings/issues-milestones": MilestoneIcon,
  "/settings/issues-import": FileUpIcon,
  "/settings/issues-enrichment": WandSparklesIcon,
  "/settings/email": MailIcon,
  "/settings/archived": ArchiveIcon,
  "/settings/diagnostics": ActivityIcon,
};

function SettingsSectionIcon({ to }: { to: SettingsSearchPath }) {
  const Icon = SETTINGS_SECTION_ICONS[settingsSectionPathForSearchPath(to)];
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/60" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const companySettings = useCompanySettings();
  const integrationsClient = useCompanyIntegrationsClient();
  const [integrationsAttentionCount, setIntegrationsAttentionCount] = useState(0);
  const workspaceKind = companySettings.workspaceKind;
  const integrationsRead = permissionGate(companySettings.permissions, "integrations.read").enabled;
  useEffect(() => {
    if (
      workspaceKind !== "organization" ||
      companySettings.companyId === null ||
      integrationsClient === null ||
      !integrationsRead
    ) {
      setIntegrationsAttentionCount(0);
      return;
    }
    let active = true;
    const load = () => {
      void integrationsClient
        .attentionCount(companySettings.companyId!)
        .then((count) => {
          if (!active) return;
          setIntegrationsAttentionCount(count);
        })
        .catch(() => {
          if (active) setIntegrationsAttentionCount(0);
        });
    };
    load();
    const refresh = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(refresh);
    };
  }, [companySettings.companyId, integrationsClient, integrationsRead, workspaceKind]);
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(
    () =>
      searchSettings(query).filter((item) =>
        settingsPathIsVisibleForWorkspace(item.to, workspaceKind),
      ),
    [query, workspaceKind],
  );
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          // Keep focus inside open dialogs and popups instead of escaping
          // their focus trap into the sidebar search.
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
      ) {
        return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, open, setOpen, setOpenMobile]);

  const handleSectionClick = useCallback(
    (to: SettingsPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, hash: "", replace: true, hashScrollIntoView: false });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const selectSettingsScope = useCallback(
    (scope: typeof companySettings.settingsCompanyScope) => {
      companySettings.setSettingsCompanyScope(scope);
      if (scope !== SETTINGS_PROFILE_SCOPE) return;
      const currentSection = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths).find(
        (path) => pathname === path || pathname.startsWith(`${path}/`),
      );
      if (
        currentSection !== undefined &&
        !settingsPathIsVisibleForWorkspace(currentSection, "profile")
      ) {
        void navigate({ to: "/settings/general", replace: true });
      }
    },
    [companySettings, navigate, pathname],
  );
  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const handleSearchResultClick = useCallback(
    (item: SettingsSearchItem) => {
      clearSearch();
      if (isMobile) {
        setOpenMobile(false);
      }
      const targetId = item.targetId ?? item.id;
      if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
        scrollToSettingsTarget(targetId);
        return;
      }
      void navigate({ to: item.to, hash: targetId, replace: true, hashScrollIntoView: false });
    },
    [clearSearch, currentHash, isMobile, navigate, pathname, setOpenMobile],
  );
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && isSearching) {
        event.preventDefault();
        event.stopPropagation();
        clearSearch();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveResultIndex((index) => (index + 1) % results.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = results[activeResultIndex];
        if (result) handleSearchResultClick(result);
      }
    },
    [activeResultIndex, clearSearch, handleSearchResultClick, isSearching, results],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          {companySettings.organizationCompanies.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Choose settings profile or company"
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-row-hover"
              >
                {companySettings.activeCompany === null ? (
                  <UserRoundIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                ) : (
                  <Building2Icon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {companySettings.activeCompany?.name ?? "Your profile"}
                </span>
                <ChevronDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground/70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[calc(var(--sidebar-width)-1rem)]"
                sideOffset={4}
              >
                <DropdownMenuCheckboxItem
                  checked={
                    companySettings.settingsCompanyScope === SETTINGS_PROFILE_SCOPE ||
                    (companySettings.settingsCompanyScope === SETTINGS_AUTO_SCOPE &&
                      companySettings.companyId === null)
                  }
                  onCheckedChange={(checked) => {
                    if (checked) selectSettingsScope(SETTINGS_PROFILE_SCOPE);
                  }}
                >
                  Your profile
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {companySettings.organizationCompanies.map((company) => (
                  <DropdownMenuCheckboxItem
                    checked={company.id === companySettings.companyId}
                    key={company.id}
                    onCheckedChange={(checked) => {
                      if (checked) selectSettingsScope(company.id);
                    }}
                  >
                    <span className="block truncate">{company.name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <Input
              ref={searchInputRef}
              nativeInput
              unstyled
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveResultIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search"
              aria-label="Search settings"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isSearching && hasResults}
              aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
              aria-activedescendant={
                isSearching && results[activeResultIndex]
                  ? `settings-search-result-${results[activeResultIndex].id}`
                  : undefined
              }
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
            />
            {isSearching ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
                aria-label="Clear settings search"
                onClick={() => {
                  clearSearch();
                  searchInputRef.current?.focus();
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">/</Kbd>
            )}
          </div>
          {isSearching && results.length === 0 ? (
            <p
              role="status"
              className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No settings found
            </p>
          ) : null}
          {isSearching ? (
            <SidebarMenu
              className="ps-px"
              id={hasResults ? "settings-search-results" : undefined}
              role={hasResults ? "listbox" : undefined}
              aria-label={hasResults ? "Settings search results" : undefined}
            >
              {results.map((item, index) => (
                <SidebarMenuItem key={item.id} role="presentation">
                  <SidebarMenuButton
                    id={`settings-search-result-${item.id}`}
                    role="option"
                    aria-selected={index === activeResultIndex}
                    tabIndex={-1}
                    size="sm"
                    isActive={index === activeResultIndex}
                    className="h-auto min-h-10 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    onMouseMove={() => setActiveResultIndex(index)}
                    onClick={() => handleSearchResultClick(item)}
                  >
                    <SettingsSectionIcon to={item.to} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-sidebar-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                        {SETTINGS_SECTION_LABELS[settingsSectionPathForSearchPath(item.to)]}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.label} className="flex min-w-0 flex-col">
                <SidebarGroupLabel className="text-sidebar-muted-foreground/75">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarMenu className="ps-px">
                  {group.paths
                    .filter((to) => settingsPathIsVisibleForWorkspace(to, workspaceKind))
                    .map((to) => {
                      const Icon = SETTINGS_SECTION_ICONS[to];
                      // Prefix match keeps the section active on nested routes
                      // like /settings/projects/$projectKey.
                      const isActive = pathname === to || pathname.startsWith(`${to}/`);
                      return (
                        <SidebarMenuItem key={to}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => handleSectionClick(to)}
                          >
                            <Icon />
                            <span className="truncate">{SETTINGS_SECTION_LABELS[to]}</span>
                            {to === "/settings/integrations" && integrationsAttentionCount > 0 ? (
                              <span className="ms-auto flex min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-[10px] font-medium text-warning-foreground">
                                {integrationsAttentionCount}
                              </span>
                            ) : null}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                </SidebarMenu>
              </div>
            ))
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <PathwayConnectSidebarSignIn />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
