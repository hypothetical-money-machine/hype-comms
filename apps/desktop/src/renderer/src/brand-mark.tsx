import hypeCommsMark from "./assets/hype-comms-mark.png";

interface BrandMarkProps {
  readonly className: string;
  readonly label?: string;
}

export function BrandMark({ className, label = "" }: BrandMarkProps) {
  return <img className={className} src={hypeCommsMark} alt={label} />;
}
