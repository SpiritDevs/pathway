import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import type { ReactNode } from "react";

// `lucide-react/dynamic` carries a name-to-import map for every icon, so this
// module is only ever loaded through `React.lazy`.
const LUCIDE_ICON_NAMES = new Set<string>(iconNames);

function resolveLucideIconName(iconName: string): IconName | null {
  const normalized = iconName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
  return LUCIDE_ICON_NAMES.has(normalized) ? (normalized as IconName) : null;
}

/** Renders any Lucide icon by PascalCase, kebab-case, or snake_case name. */
export default function LucideNamedIcon(props: {
  readonly iconName: string;
  readonly fallback: () => ReactNode;
  readonly className?: string;
}) {
  const iconName = resolveLucideIconName(props.iconName);
  return iconName === null ? (
    props.fallback()
  ) : (
    <DynamicIcon name={iconName} fallback={props.fallback} className={props.className} />
  );
}
