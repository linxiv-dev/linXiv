import markUrl from "../../assets/linxiv-mark.svg";
import { cn } from "../../lib/cn";

/**
 * The logo mark, tinted to the current accent. The source art is a single
 * flat colour, so masking it recolours the whole mark from one file.
 */
export function LogoMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block shrink-0 bg-accent", className)}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(${markUrl})`,
        maskImage: `url(${markUrl})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
