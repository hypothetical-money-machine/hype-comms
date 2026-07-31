import { useEffect, useState } from "react";

import type { DesktopApi } from "../../shared/desktop-api";

type VersionClient = Pick<DesktopApi, "getAppVersion">;

export function ClientVersion({ client }: { readonly client: VersionClient }) {
  const [version, setVersion] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .getAppVersion()
      .then((value) => {
        if (!active) return;
        const normalized = value.trim();
        if (normalized === "") {
          setUnavailable(true);
          return;
        }
        setVersion(normalized);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });

    return () => {
      active = false;
    };
  }, [client]);

  return (
    <p className="client-version" aria-live="polite">
      {version === null
        ? unavailable
          ? "Hype Comms · version unavailable"
          : "Hype Comms · checking version…"
        : `Hype Comms · v${version}`}
    </p>
  );
}
