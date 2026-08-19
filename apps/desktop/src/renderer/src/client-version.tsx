import { useEffect, useState } from "react";

import type { DesktopApi } from "../../shared/desktop-api";

type VersionClient = Pick<DesktopApi, "getAppVersion">;

const COMPILED_PRODUCT_NAME =
  typeof __HYPE_COMMS_PRODUCT_NAME__ === "string" ? __HYPE_COMMS_PRODUCT_NAME__ : "Hype Comms DEV";

interface ClientVersionProps {
  readonly client: VersionClient;
  readonly productName?: string;
}

export function ClientVersion({ client, productName = COMPILED_PRODUCT_NAME }: ClientVersionProps) {
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
          ? `${productName} · version unavailable`
          : `${productName} · checking version…`
        : `${productName} · v${version}`}
    </p>
  );
}
