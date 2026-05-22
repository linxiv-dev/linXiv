export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-panel rounded-lg border border-border p-6 mb-4">
      <h2 className="text-text font-semibold mb-4">{title}</h2>
      {children}
    </div>
  );
}
