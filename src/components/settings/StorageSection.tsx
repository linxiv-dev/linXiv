import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../../api/settings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Section } from "./Section";

export function StorageSection() {
  const qc = useQueryClient();

  const {
    data: settings,
    isLoading: settingsLoading,
    isError: settingsError,
  } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const [pdfLimit, setPdfLimit] = useState<string>("");

  useEffect(() => {
    if (typeof settings?.pdf_save_limit_mb === "number") {
      setPdfLimit(String(settings.pdf_save_limit_mb));
    }
  }, [settings?.pdf_save_limit_mb]);

  const limitNum = Number(pdfLimit);
  const limitValid = pdfLimit !== "" && Number.isInteger(limitNum) && limitNum >= 1;

  const { mutate: save, isPending: saving, isError: saveError } = useMutation({
    mutationFn: () => updateSettings({ pdf_save_limit_mb: limitNum }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <Section title="Storage">
      <div className="flex flex-col gap-1 mb-2">
        <label className="text-sm text-muted font-medium">PDF Storage Limit (MB)</label>
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        ) : settingsError ? (
          <p className="text-xs text-danger">Could not load settings.</p>
        ) : (
          <>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                value={pdfLimit}
                onChange={(e) => setPdfLimit(e.target.value)}
                min={1}
                style={{ width: 120 }}
              />
              <Button size="sm" disabled={!limitValid || saving} onClick={() => save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
            {saveError && (
              <p className="text-xs text-danger mt-1">Failed to save. Please try again.</p>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
