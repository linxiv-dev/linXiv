import { AppearanceSection } from "../components/settings/AppearanceSection";
import { ApiKeysSection } from "../components/settings/ApiKeysSection";
import { StorageSection } from "../components/settings/StorageSection";
import { CrossRefSection } from "../components/settings/CrossRefSection";
import { SearchSection } from "../components/settings/SearchSection";
import { SidebarSection } from "../components/settings/SidebarSection";
import { ExportSection } from "../components/settings/ExportSection";
import { IntegrationsSection } from "../components/settings/IntegrationsSection";
import { TrashSection } from "../components/settings/TrashSection";

function Divider() {
  return (
    <div
      className="border-t border-border mb-4"
      style={{ marginLeft: -8, marginRight: -8 }}
    />
  );
}

export default function SettingsPage() {
  return (
    <div className="overflow-y-auto h-full" style={{ background: "var(--color-bg)" }}>
      <div className="mx-auto py-8 px-8" style={{ maxWidth: 800 }}>
        <h1 className="text-xl font-bold text-text mb-6">Settings</h1>

        <AppearanceSection />
        <Divider />
        <ApiKeysSection />
        <Divider />
        <StorageSection />
        <Divider />
        <CrossRefSection />
        <Divider />
        <SearchSection />
        <SidebarSection />
        <Divider />
        <ExportSection />
        <Divider />
        <IntegrationsSection />
        <Divider />
        <TrashSection />
      </div>
    </div>
  );
}
