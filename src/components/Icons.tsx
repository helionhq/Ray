import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const HistoryIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.2 8a5.8 5.8 0 1 0 1.7-4.1" />
    <path d="M2.2 2.6v3.2h3.2" />
    <path d="M8 5.1V8l2 1.2" />
  </Icon>
);

export const DictionaryIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 2.8h7.2a2 2 0 0 1 2 2v8.4H5a2 2 0 0 1-2-2V2.8Z" />
    <path d="M5 13.2a2 2 0 0 1 0-4h7.2" />
    <path d="M6 5h3.5" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.4 4.5h11.2M2.4 11.5h11.2" />
    <circle cx="6" cy="4.5" r="1.6" fill="var(--surface)" />
    <circle cx="10.4" cy="11.5" r="1.6" fill="var(--surface)" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="m10.4 10.4 3 3" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.2" y="5.2" width="7.6" height="7.6" rx="1.6" />
    <path d="M10.8 5.2V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v5.2A1.6 1.6 0 0 0 4 10.8h1.2" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.8 4.3h10.4M6.2 4.3V3a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.3" />
    <path d="M4.3 4.3l.6 8.1a1.3 1.3 0 0 0 1.3 1.2h3.6a1.3 1.3 0 0 0 1.3-1.2l.6-8.1" />
    <path d="M6.7 7v3.6M9.3 7v3.6" />
  </Icon>
);

export const XIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5.5 6.5 2.5 2.5 2.5-2.5" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.2 8.4 3 3 6.6-6.8" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.6 8s2.3-4 6.4-4 6.4 4 6.4 4-2.3 4-6.4 4-6.4-4-6.4-4Z" />
    <circle cx="8" cy="8" r="1.7" />
  </Icon>
);

export const EyeOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.4 2.4l11.2 11.2" />
    <path d="M6.2 4.3A6.7 6.7 0 0 1 8 4c4.1 0 6.4 4 6.4 4a11 11 0 0 1-2.4 2.8" />
    <path d="M4.4 5.3A11 11 0 0 0 1.6 8s2.3 4 6.4 4c.9 0 1.7-.2 2.4-.5" />
    <path d="M6.8 7a1.7 1.7 0 0 0 2.3 2.3" />
  </Icon>
);

export const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.6" y="1.8" width="4.8" height="7.6" rx="2.4" />
    <path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0M8 12v2.2" />
  </Icon>
);

export const KeyboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="1.6" y="4" width="12.8" height="8" rx="1.8" />
    <path d="M4 6.6h.01M6.4 6.6h.01M8.8 6.6h.01M11.2 6.6h.01M4 9.6h8" />
  </Icon>
);

export const RayMark = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <rect width="24" height="24" rx="6.5" fill="currentColor" />
    <g fill="var(--surface)">
      <rect x="6" y="8" width="2" height="8" rx="1" />
      <rect x="10" y="6" width="2" height="12" rx="1" />
      <rect x="14" y="9" width="2" height="6" rx="1" />
    </g>
  </svg>
);
