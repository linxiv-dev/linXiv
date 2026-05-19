import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Spinner } from "../ui/spinner";
import GraphPage from "../../pages/GraphPage";
import SearchPage from "../../pages/SearchPage";

const KEEP_ALIVE = ["/graph", "/search"];

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
  const onKeepAlive = KEEP_ALIVE.includes(pathname);

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

        <div
          className="absolute inset-0 flex flex-col overflow-y-auto"
          style={{ display: pathname === "/search" ? "flex" : "none" }}
        >
          <SearchPage />
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