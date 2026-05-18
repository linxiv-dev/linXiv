import { NavLink } from "react-router-dom";
import {
  Home,
  BookOpen,
  FolderOpen,
  Network,
  Search,
  Link2,
  Settings,
} from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", icon: <Home size={16} />, end: true },
  { to: "/library", label: "Library", icon: <BookOpen size={16} /> },
  { to: "/projects", label: "Projects", icon: <FolderOpen size={16} /> },
  { to: "/graph", label: "Graph", icon: <Network size={16} /> },
  { to: "/search", label: "Search", icon: <Search size={16} /> },
  { to: "/doi", label: "DOI", icon: <Link2 size={16} /> },
  { to: "/settings", label: "Settings", icon: <Settings size={16} /> },
];

export function Sidebar() {
  return (
    <aside
      className="flex flex-col h-full"
      style={{
        width: 160,
        minWidth: 160,
        backgroundColor: "var(--color-panel)",
        borderRight: "1px solid var(--color-border)",
      }}
    >
      {/* Logo */}
      <div className="px-4 py-5 select-none">
        <span
          className="text-lg font-bold tracking-tight"
          style={{ color: "var(--color-accent)" }}
        >
          linXiv
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 pb-4 flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ to, label, icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: "none",
              transition: "background-color 0.15s, color 0.15s",
              backgroundColor: isActive ? "var(--color-accent)" : "transparent",
              color: isActive ? "var(--color-bg)" : "var(--color-muted)",
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
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
