import {
  BikeIcon,
  BookOpenIcon,
  BrainIcon,
  BriefcaseIcon,
  Building2Icon,
  CalendarDaysIcon,
  CameraIcon,
  CircleDotIcon,
  ClipboardListIcon,
  Code2Icon,
  CoffeeIcon,
  CompassIcon,
  DumbbellIcon,
  FlaskConicalIcon,
  FolderKanbanIcon,
  Gamepad2Icon,
  Globe2Icon,
  GraduationCapIcon,
  HammerIcon,
  HeartIcon,
  HouseIcon,
  LandmarkIcon,
  LaptopIcon,
  LightbulbIcon,
  MicroscopeIcon,
  MountainIcon,
  MusicIcon,
  PaletteIcon,
  PiggyBankIcon,
  PlaneIcon,
  RocketIcon,
  ShoppingBagIcon,
  SproutIcon,
  StarIcon,
  TargetIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

export interface FocusIconOption {
  readonly name: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

export const FOCUS_ICON_OPTIONS: ReadonlyArray<FocusIconOption> = [
  { name: "Briefcase", label: "Work", icon: BriefcaseIcon },
  { name: "House", label: "Home", icon: HouseIcon },
  { name: "Heart", label: "Personal", icon: HeartIcon },
  { name: "Star", label: "Favorites", icon: StarIcon },
  { name: "Rocket", label: "Launch", icon: RocketIcon },
  { name: "GraduationCap", label: "Study", icon: GraduationCapIcon },
  { name: "BookOpen", label: "Reading", icon: BookOpenIcon },
  { name: "Lightbulb", label: "Ideas", icon: LightbulbIcon },
  { name: "Code2", label: "Code", icon: Code2Icon },
  { name: "Terminal", label: "Development", icon: TerminalIcon },
  { name: "Palette", label: "Creative", icon: PaletteIcon },
  { name: "Music", label: "Music", icon: MusicIcon },
  { name: "Camera", label: "Photography", icon: CameraIcon },
  { name: "Plane", label: "Travel", icon: PlaneIcon },
  { name: "Dumbbell", label: "Fitness", icon: DumbbellIcon },
  { name: "Gamepad2", label: "Games", icon: Gamepad2Icon },
  { name: "Coffee", label: "Break", icon: CoffeeIcon },
  { name: "Sprout", label: "Growth", icon: SproutIcon },
  { name: "Target", label: "Goals", icon: TargetIcon },
  { name: "Zap", label: "Fast lane", icon: ZapIcon },
  { name: "Brain", label: "Thinking", icon: BrainIcon },
  { name: "Compass", label: "Explore", icon: CompassIcon },
  { name: "FolderKanban", label: "Projects", icon: FolderKanbanIcon },
  { name: "ClipboardList", label: "Planning", icon: ClipboardListIcon },
  { name: "CalendarDays", label: "Schedule", icon: CalendarDaysIcon },
  { name: "Users", label: "Team", icon: UsersIcon },
  { name: "Building2", label: "Business", icon: Building2Icon },
  { name: "Laptop", label: "Computer", icon: LaptopIcon },
  { name: "Wrench", label: "Maintenance", icon: WrenchIcon },
  { name: "Hammer", label: "Build", icon: HammerIcon },
  { name: "FlaskConical", label: "Experiments", icon: FlaskConicalIcon },
  { name: "Microscope", label: "Research", icon: MicroscopeIcon },
  { name: "Landmark", label: "Finance", icon: LandmarkIcon },
  { name: "PiggyBank", label: "Savings", icon: PiggyBankIcon },
  { name: "ShoppingBag", label: "Shopping", icon: ShoppingBagIcon },
  { name: "Globe2", label: "World", icon: Globe2Icon },
  { name: "Mountain", label: "Outdoors", icon: MountainIcon },
  { name: "Bike", label: "Cycling", icon: BikeIcon },
] as const;

const FOCUS_ICON_BY_NAME = new Map(
  FOCUS_ICON_OPTIONS.map((option) => [option.name, option.icon] as const),
);

export function focusIconForName(iconName: string): LucideIcon {
  return FOCUS_ICON_BY_NAME.get(iconName) ?? CircleDotIcon;
}

export function FocusIcon(props: {
  readonly iconName: string;
  readonly className?: string;
  readonly color?: string;
}) {
  const Icon = focusIconForName(props.iconName);
  return <Icon aria-hidden className={props.className} style={{ color: props.color }} />;
}
