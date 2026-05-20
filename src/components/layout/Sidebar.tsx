import { NavLink } from "react-router-dom";
import {
  Home,
  BookOpen,
  FolderOpen,
  Network,
  Search,
  Link2,
  Settings,
  Tag,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useUiStore, type SidebarPageKey } from "../../stores/ui";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
  pageKey?: SidebarPageKey;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", icon: <Home size={16} />, end: true },
  { to: "/library", label: "Library", icon: <BookOpen size={16} /> },
  { to: "/projects", label: "Projects", icon: <FolderOpen size={16} /> },
  { to: "/graph", label: "Graph", icon: <Network size={16} />, pageKey: "graph" },
  { to: "/search", label: "Search", icon: <Search size={16} />, pageKey: "search" },
  { to: "/doi", label: "DOI", icon: <Link2 size={16} />, pageKey: "doi" },
  { to: "/tags", label: "Tags", icon: <Tag size={16} />, pageKey: "tags" },
  { to: "/notes", label: "Notes", icon: <FileText size={16} />, pageKey: "notes" },
  { to: "/settings", label: "Settings", icon: <Settings size={16} /> },
];

const EXPANDED_W = 160;
const COLLAPSED_W = 48;

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar, sidebarPages } = useUiStore();
  const w = sidebarCollapsed ? COLLAPSED_W : EXPANDED_W;

  return (
    <aside
      style={{
        width: w,
        minWidth: w,
        backgroundColor: "var(--color-panel)",
        borderRight: "1px solid var(--color-border)",
        transition: "width 200ms ease, min-width 200ms ease",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Logo / collapse toggle */}
      <div
        className="flex items-center px-3 py-5 select-none"
        style={{ minHeight: 56, justifyContent: sidebarCollapsed ? "center" : "space-between" }}
      >
        {!sidebarCollapsed && (
          <span
            className="text-lg font-bold tracking-tight"
            style={{ color: "var(--color-accent)" }}
          >
            linXiv
          </span>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            color: "var(--color-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-text)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-muted)")}
        >
          {sidebarCollapsed
            ? <PanelLeftOpen size={16} />
            : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 pb-4 flex flex-col gap-0.5">
        {NAV_ITEMS.filter(({ pageKey }) => !pageKey || sidebarPages[pageKey]).map(({ to, label, icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={sidebarCollapsed ? label : undefined}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              justifyContent: sidebarCollapsed ? "center" : "flex-start",
              gap: 8,
              padding: sidebarCollapsed ? "8px 0" : "6px 10px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: "none",
              transition: "background-color 0.15s, color 0.15s",
              backgroundColor: isActive ? "var(--color-accent)" : "transparent",
              color: isActive ? "white" : "var(--color-muted)",
            })}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              if (!el.getAttribute("aria-current")) {
                el.style.color = "var(--color-text)";
              }
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              if (!el.getAttribute("aria-current")) {
                el.style.color = "var(--color-muted)";
              }
            }}
          >
            {icon}
            {!sidebarCollapsed && <span style={{ whiteSpace: "nowrap" }}>{label}</span>}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
