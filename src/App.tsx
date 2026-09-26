import { lazy, useEffect } from "react";
import { isTauri } from "./api/client";
import { clipInputFromDeepLink } from "./lib/clipDeepLink";
import { createBrowserRouter, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import AppShell from "./components/layout/AppShell";
import TermsGate from "./components/TermsGate";

const HomePage = lazy(() => import("./pages/HomePage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const PaperDetailPage = lazy(() => import("./pages/PaperDetailPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectDetailPage = lazy(() => import("./pages/ProjectDetailPage"));
const ReadingListsPage = lazy(() => import("./pages/ReadingListsPage"));
const SharePage = lazy(() => import("./pages/SharePage"));
const DoiPage = lazy(() => import("./pages/DoiPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const TagPage = lazy(() => import("./pages/TagPage"));
const AuthorPage = lazy(() => import("./pages/AuthorPage"));
const PdfPreviewPage = lazy(() => import("./pages/PdfPreviewPage"));
const NotePage = lazy(() => import("./pages/NotePage"));

// Forces a full remount of PaperDetailPage when sfk changes, so all
// useState initializers run fresh and no stale state drives incorrect queries.
function KeyedPaperDetailPage() {
  const { sfk } = useParams<{ sfk: string }>();
  return <PaperDetailPage key={sfk} />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "library/:sfk", element: <KeyedPaperDetailPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:id", element: <ProjectDetailPage /> },
      { path: "reading", element: <ReadingListsPage /> },
      { path: "shared", element: <SharePage /> },
      { path: "graph", element: null },
      { path: "editor", element: null },
      { path: "search", element: <SearchPage /> },
      { path: "tags", element: <TagPage /> },
      { path: "tags/:label", element: <TagPage /> },
      { path: "authors", element: <AuthorPage /> },
      { path: "authors/:id", element: <AuthorPage /> },
      { path: "notes", element: null },
      { path: "notes/:id", element: <NotePage /> },
      { path: "doi", element: <DoiPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "pdf-preview", element: <PdfPreviewPage /> },
    ],
  },
]);

function DeepLinkBridge() {
  useEffect(() => {
    if (!isTauri) {
      return;
    }

    let unlisten: (() => void) | undefined;

    function handleUrls(urls: string[]) {
      for (const rawUrl of urls) {
        const input = clipInputFromDeepLink(rawUrl);

        if (input) {
          void router.navigate(
            `/doi?input=${encodeURIComponent(input)}&submit=1`
          );

          return;
        }
      }
    }

    void (async () => {
      const { getCurrent, onOpenUrl } =
        await import("@tauri-apps/plugin-deep-link");

      const currentUrls = await getCurrent();

      if (currentUrls) {
        handleUrls(currentUrls);
      }

      unlisten = await onOpenUrl(handleUrls);
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  return null;
}

export default function App() {
  return (
    <TermsGate>
      <DeepLinkBridge />
      <RouterProvider router={router} />
    </TermsGate>
  );
}
