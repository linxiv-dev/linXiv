import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSettings, updateEnv } from "../../api/settings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Section } from "./Section";

export function CrossRefSection() {
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const [crossrefEmail, setCrossrefEmail] = useState("");
  const [populated, setPopulated] = useState(false);
  if (settings && !populated) {
    if (typeof (settings as Record<string, unknown>)["CROSSREF_MAILTO"] === "string") {
      setCrossrefEmail((settings as Record<string, unknown>)["CROSSREF_MAILTO"] as string);
    }
    setPopulated(true);
  }

  return (
    <Section title="CrossRef">
      <div className="flex flex-col gap-1 mb-2">
        <label className="text-sm text-muted font-medium">Contact Email</label>
        <p className="text-xs text-muted mb-2">
          Used as the{" "}
          <code className="text-accent">mailto</code> parameter for polite CrossRef API access.
        </p>
        <div className="flex gap-2 items-center">
          <Input
            type="email"
            value={crossrefEmail}
            onChange={(e) => setCrossrefEmail(e.target.value)}
            placeholder="you@example.com"
            style={{ maxWidth: 320 }}
          />
          <Button
            size="sm"
            onClick={() => updateEnv("CROSSREF_MAILTO", crossrefEmail).catch(console.error)}
          >
            Save
          </Button>
        </div>
      </div>
    </Section>
  );
}
