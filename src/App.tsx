import { lazy, useEffect } from "react";
import { isTauri } from "./api/client";
import { importBibtex } from "./api/exportImport";
import { getPaper } from "./api/papers";
import { clipPayloadFromDeepLink } from "./lib/clipDeepLink";
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
    // Route ids double as the <body data-page> value AppShell sets for page-scoped CSS.
    children: [
      { index: true, id: "home", element: <HomePage /> },
      { path: "library", id: "library", element: <LibraryPage /> },
      { path: "library/:sfk", id: "paper", element: <KeyedPaperDetailPage /> },
      { path: "projects", id: "projects", element: <ProjectsPage /> },
      { path: "projects/:id", id: "project", element: <ProjectDetailPage /> },
      { path: "reading", id: "reading", element: <ReadingListsPage /> },
      { path: "shared", id: "shared", element: <SharePage /> },
      { path: "graph", id: "graph", element: null },
      { path: "editor", id: "editor", element: null },
      { path: "search", id: "search", element: <SearchPage /> },
      { path: "tags", id: "tags", element: <TagPage /> },
      { path: "tags/:label", id: "tag", element: <TagPage /> },
      { path: "authors", id: "authors", element: <AuthorPage /> },
      { path: "authors/:id", id: "author", element: <AuthorPage /> },
      { path: "notes", id: "notes", element: null },
      { path: "notes/:id", id: "note", element: <NotePage /> },
      { path: "doi", id: "doi", element: <DoiPage /> },
      { path: "settings", id: "settings", element: <SettingsPage /> },
      { path: "pdf-preview", id: "pdf-preview", element: <PdfPreviewPage /> },
    ],
  },
]);

function DeepLinkBridge() {
  useEffect(() => {
    if (!isTauri) {
      return;
    }

    let unlisten: (() => void) | undefined;

    async function handleUrls(urls: string[]) {
      for (const rawUrl of urls) {
        const payload = clipPayloadFromDeepLink(rawUrl);

        if (!payload) {
          continue;
        }

        if (payload.kind === "input") {
          await router.navigate(
            `/doi?input=${encodeURIComponent(payload.value)}&submit=1`
          );
          return;
        }

        const file = new File([payload.value], "linxiv-clip.bib", {
          type: "application/x-bibtex",
        });
        const receipt = await importBibtex(file);
        const sourceId = receipt.source_ids[0];

        if (!sourceId) {
          throw new Error("BibTeX import did not return a paper source id.");
        }

        const paper = await getPaper(sourceId);
        await router.navigate(`/library/${paper.source_fk}`);
        return;
      }
    }

    void (async () => {
      const { getCurrent, onOpenUrl } =
        await import("@tauri-apps/plugin-deep-link");

      const currentUrls = await getCurrent();

      if (currentUrls) {
        await handleUrls(currentUrls);
      }

      unlisten = await onOpenUrl((urls) => {
        void handleUrls(urls).catch((error) => {
          console.error("Failed to handle linXiv clip deep link", error);
        });
      });
    })().catch((error) => {
      console.error("Failed to initialize linXiv clip deep links", error);
    });

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
