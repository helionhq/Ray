import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v3.5" />
  </Icon>
);

export const WaveIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 12h2M7.5 8v8M12 4.5v15M16.5 7v10M21 10.5v3" />
  </Icon>
);

export const CleanupIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 3.5 12.8 8l4.5 1.8-4.5 1.8L11 16l-1.8-4.4L4.7 9.8 9.2 8 11 3.5Z" />
    <path d="m18.5 14.5.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" />
  </Icon>
);

export const BookIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 19V5.5A1.5 1.5 0 0 1 6.5 4H19v13H6.5A1.5 1.5 0 0 0 5 18.5 1.5 1.5 0 0 0 6.5 20H19" />
    <path d="M9 8h6" />
  </Icon>
);

export const AppsIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
  </Icon>
);

export const KeyboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.3 10h.01M12.6 10h.01M15.9 10h.01M19 10h.01M6 13.6h.01M9.3 13.6h.01M12.6 13.6h.01M15.9 13.6h.01M19 13.6h.01M7.5 16.3h9" />
  </Icon>
);

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.8 19.5 5.5v5.6c0 4.6-3.1 8-7.5 9.6-4.4-1.6-7.5-5-7.5-9.6V5.5L12 2.8Z" />
    <path d="m8.7 11.8 2.2 2.2 4.4-4.4" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5v10" />
    <path d="m7.5 9 4.5 4.5L16.5 9" />
    <path d="M5 19.5h14" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5M12 16.2h.01" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const CreditCardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.5" />
    <path d="M2.8 9.5h18.4M6.5 14.5h3" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4.5h5.5V10M19 5l-7.5 7.5" />
    <path d="M18 14.5v3A2.5 2.5 0 0 1 15.5 20h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6h3" />
  </Icon>
);

export const LogOutIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h3.5" />
    <path d="M15 8.5 18.5 12 15 15.5M9 12h9.5" />
  </Icon>
);

export const WindowsIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.6" />
    <path d="M9 20h6M12 16v4" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const LockIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);

export const SparkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5 13.6 8l4.5 1.6-4.5 1.6L12 15.7 10.4 11.2 5.9 9.6 10.4 8 12 3.5Z" />
  </Icon>
);
