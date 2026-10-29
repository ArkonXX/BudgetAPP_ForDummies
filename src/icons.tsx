import type { ReactNode } from "react";

/** Thin line icons drawn in currentColor, so they follow the text colour. */
function Svg({ children, size = 22, fill }: { children: ReactNode; size?: number; fill?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {children}
    </svg>
  );
}

export type IconName =
  | "home"
  | "list"
  | "pie"
  | "target"
  | "card"
  | "bars"
  | "trend"
  | "swap"
  | "calendar"
  | "grid"
  | "gear"
  | "more"
  | "plus"
  | "left"
  | "right"
  | "import";

export function Icon({ name, size }: { name: IconName; size?: number }) {
  switch (name) {
    case "home":
      return (
        <Svg size={size}>
          <path d="M4 11l8-7 8 7" />
          <path d="M6 9.5V20h12V9.5" />
        </Svg>
      );
    case "list":
      return (
        <Svg size={size}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </Svg>
      );
    case "pie":
      return (
        <Svg size={size}>
          <path d="M12 3a9 9 0 1 0 9 9h-9z" />
          <path d="M15 3.5A9 9 0 0 1 20.5 9H15z" />
        </Svg>
      );
    case "target":
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3.5" />
        </Svg>
      );
    case "card":
      return (
        <Svg size={size}>
          <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
          <path d="M3 10h18M7 15h3" />
        </Svg>
      );
    case "bars":
      return (
        <Svg size={size}>
          <path d="M5 20V11M12 20V5M19 20v-6" />
        </Svg>
      );
    case "trend":
      return (
        <Svg size={size}>
          <path d="M4 17l5-5 4 3 7-8M15 7h5v5" />
        </Svg>
      );
    case "swap":
      return (
        <Svg size={size}>
          <path d="M4 8h14l-3-3M20 16H6l3 3" />
        </Svg>
      );
    case "grid":
      return (
        <Svg size={size}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15" />
        </Svg>
      );
    case "calendar":
      return (
        <Svg size={size}>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </Svg>
      );
    case "gear":
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
        </Svg>
      );
    case "more":
      return (
        <Svg size={size} fill>
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </Svg>
      );
    case "plus":
      return (
        <Svg size={size}>
          <path d="M12 5v14M5 12h14" />
        </Svg>
      );
    case "left":
      return (
        <Svg size={size}>
          <path d="M15 6l-6 6 6 6" />
        </Svg>
      );
    case "right":
      return (
        <Svg size={size}>
          <path d="M9 6l6 6-6 6" />
        </Svg>
      );
    case "import":
      return (
        <Svg size={size}>
          <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
          <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
        </Svg>
      );
  }
}
