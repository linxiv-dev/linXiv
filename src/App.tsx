import { lazy } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import AppShell from "./components/layout/AppShell";

const HomePage = lazy(() => import("./pages/HomePage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const PaperDetailPage = lazy(() => import("./pages/PaperDetailPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectDetailPage = lazy(() => import("./pages/ProjectDetailPage"));
const DoiPage = lazy(() => import("./pages/DoiPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "library/:sfk", element: <PaperDetailPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:id", element: <ProjectDetailPage /> },
      { path: "graph", element: null },
      { path: "search", element: null },
      { path: "tags", element: null },
      { path: "notes", element: null },
      { path: "doi", element: <DoiPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
