import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Spinner } from "../ui/spinner";

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
  return (
    <div
      className="flex h-full"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <Sidebar />
      <main
        className="flex-1 overflow-y-auto"
        style={{ backgroundColor: "var(--color-bg)" }}
      >
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
