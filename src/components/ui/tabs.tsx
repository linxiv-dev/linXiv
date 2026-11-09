import type { ComponentPropsWithoutRef } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { cn } from "../../lib/cn";

export const Tabs = RadixTabs.Root;

export function TabsList({
  className = "",
  ...rest
}: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn("flex border-b border-border", className)}
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
      className={cn(
        "px-4 py-2 text-sm font-medium -mb-px border-b-2 border-transparent",
        "text-muted transition-colors",
        "hover:text-text",
        "data-[state=active]:text-text data-[state=active]:border-accent",
        className,
      )}
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
