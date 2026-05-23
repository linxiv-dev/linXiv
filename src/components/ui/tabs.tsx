import type { ComponentPropsWithoutRef } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";

export const Tabs = RadixTabs.Root;

export function TabsList({
  className = "",
  ...rest
}: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={["flex border-b border-[var(--color-border)]", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function TabsTrigger({
  value,
  className = "",
  ...rest
}: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      value={value}
      className={[
        "px-4 py-2 text-sm font-medium -mb-px border-b-2 border-transparent",
        "text-[var(--color-muted)] transition-colors",
        "hover:text-[var(--color-text)]",
        "data-[state=active]:text-[var(--color-text)] data-[state=active]:border-[var(--color-accent)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function TabsContent({
  value,
  className = "",
  ...rest
}: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content value={value} className={className} {...rest} />
  );
}
