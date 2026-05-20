import { Suspense, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Spinner } from "../ui/spinner";
import GraphPage from "../../pages/GraphPage";
import { useUiStore, type SidebarPageKey } from "../../stores/ui";

const KEEP_ALIVE = ["/graph"];

const ROUTE_PAGE_KEY: Record<string, SidebarPageKey> = {
  "/graph":  "graph",
  "/search": "search",
  "/doi":    "doi",
  "/tags":   "tags",
  "/notes":  "notes",
};

function PageFallback() {
  return (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <Spinner size={28} />
    </div>
  );
}

export default function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const sidebarPages = useUiStore((s) => s.sidebarPages);
  const onKeepAlive = KEEP_ALIVE.includes(pathname);

  useEffect(() => {
    const key = ROUTE_PAGE_KEY[pathname];
    if (key && !sidebarPages[key]) {
      navigate("/", { replace: true });
    }
  }, [pathname, sidebarPages, navigate]);

  return (
    <div
      className="flex h-full"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <Sidebar />
      <main
        className="flex-1 relative overflow-hidden"
        style={{ backgroundColor: "var(--color-bg)" }}
      >
        <div
          className="absolute inset-0 flex flex-col"
          style={{ display: pathname === "/graph" ? "flex" : "none" }}
        >
          <GraphPage />
        </div>

        {!onKeepAlive && (
          <div className="absolute inset-0 overflow-y-auto">
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        )}
      </main>
    </div>
  );
}