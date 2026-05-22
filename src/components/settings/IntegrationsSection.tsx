import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isCliInstalled,
  installCli,
  uninstallCli,
  listMcpClients,
  installMcp,
  uninstallMcp,
  type MpcClientStatus,
} from "../../api/integrations";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Section } from "./Section";

function IntegrationRow({
  label,
  description,
  installed,
  available = true,
  loading,
  onInstall,
  onUninstall,
}: {
  label: string;
  description: string;
  installed: boolean;
  available?: boolean;
  loading: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-3 border-b border-border last:border-0"
      style={{ opacity: available ? 1 : 0.45 }}
    >
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{label}</span>
          {installed && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                background: "color-mix(in srgb, var(--color-success) 15%, transparent)",
                color: "var(--color-success)",
              }}
            >
              installed
            </span>
          )}
          {!available && (
            <span className="text-xs text-muted">(not detected)</span>
          )}
        </div>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">
        {loading ? (
          <Spinner size={16} />
        ) : installed ? (
          <Button variant="danger" size="sm" onClick={onUninstall}>
            Uninstall
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onInstall} disabled={!available}>
            Install
          </Button>
        )}
      </div>
    </div>
  );
}

export function IntegrationsSection() {
  const qc = useQueryClient();

  const { data: cliInstalled = false, isLoading: cliLoading } = useQuery({
    queryKey: ["cli_installed"],
    queryFn: isCliInstalled,
    staleTime: 10_000,
  });

  const { data: mcpClients = [], isLoading: mcpLoading } = useQuery({
    queryKey: ["mcp_clients"],
    queryFn: listMcpClients,
    staleTime: 10_000,
  });

  const [cliPending, setCliPending] = useState(false);
  const [mcpPending, setMcpPending] = useState<string | null>(null);

  async function handleCli(action: "install" | "uninstall") {
    setCliPending(true);
    try {
      if (action === "install") await installCli();
      else await uninstallCli();
      await qc.invalidateQueries({ queryKey: ["cli_installed"] });
    } catch (e) {
      console.error(e);
    } finally {
      setCliPending(false);
    }
  }

  async function handleMcp(clientId: string, action: "install" | "uninstall") {
    setMcpPending(clientId);
    try {
      if (action === "install") await installMcp(clientId);
      else await uninstallMcp(clientId);
      await qc.invalidateQueries({ queryKey: ["mcp_clients"] });
    } catch (e) {
      console.error(e);
    } finally {
      setMcpPending(null);
    }
  }

  return (
    <Section title="Integrations">
      <p className="text-xs text-muted mb-4">
        Install linXiv tools so other apps can use them outside the GUI.
      </p>

      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">
        Command Line
      </p>
      <IntegrationRow
        label="linxiv CLI"
        description="Adds the `linxiv` command to your terminal PATH."
        installed={cliInstalled}
        available={true}
        loading={cliLoading || cliPending}
        onInstall={() => handleCli("install")}
        onUninstall={() => handleCli("uninstall")}
      />

      <p className="text-xs font-semibold text-muted uppercase tracking-wide mt-4 mb-1">
        MCP Clients
      </p>
      {mcpLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner size={14} /> Detecting clients…
        </div>
      ) : (
        mcpClients.map((client: MpcClientStatus) => (
          <IntegrationRow
            key={client.id}
            label={client.name}
            description={
              client.id === "claude"
                ? "Registers linXiv as an MCP server in Claude Desktop."
                : client.id === "cursor"
                ? "Registers linXiv as an MCP server in Cursor."
                : "Registers linXiv as an MCP server in Windsurf."
            }
            installed={client.installed}
            available={client.available}
            loading={mcpPending === client.id}
            onInstall={() => handleMcp(client.id, "install")}
            onUninstall={() => handleMcp(client.id, "uninstall")}
          />
        ))
      )}
    </Section>
  );
}
