import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';

const QR_RENDER_SIZE = 336; // rendered at 2x for crispness on hi-DPI displays

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]';

type NetworkInfo = {
  lanIps?: string[];
  port?: number;
};

type RawNetworkInfo = {
  port?: unknown;
  lanIps?: unknown;
};

const isRawNetworkInfo = (value: unknown): value is RawNetworkInfo =>
  typeof value === 'object' && value !== null;

type NetworkInfoState = {
  networkInfo: NetworkInfo | null;
  infoError: string | null;
};

const NETWORK_INFO_INITIAL: NetworkInfoState = {
  networkInfo: null,
  infoError: null,
};

const NO_LAN_IPS_MESSAGE = 'No LAN IPs reported by the server.';

const parseNetworkInfo = (value: unknown): NetworkInfo | null => {
  if (!isRawNetworkInfo(value)) {
    return null;
  }
  const result: NetworkInfo = {};
  if (typeof value.port === 'number') {
    result.port = value.port;
  }
  if (Array.isArray(value.lanIps)) {
    const ips = value.lanIps.filter((ip): ip is string => typeof ip === 'string');
    result.lanIps = ips;
  }
  return result;
};

const fetchNetworkInfo = async (): Promise<NetworkInfo | null> => {
  try {
    const response = await fetch('/api/network-info');
    if (!response.ok) {
      return null;
    }
    const raw: unknown = await response.json();
    return parseNetworkInfo(raw);
  } catch {
    return null;
  }
};

const useNetworkInfo = (): NetworkInfoState => {
  const [state, setState] = useState<NetworkInfoState>(NETWORK_INFO_INITIAL);

  useEffect(() => {
    let cancelled = false;
    fetchNetworkInfo()
      .then((info) => {
        if (cancelled) {
          return null;
        }
        if (info === null) {
          setState({ networkInfo: null, infoError: null });
          return null;
        }
        const lanIps = info.lanIps ?? [];
        if (lanIps.length === 0) {
          setState({ networkInfo: info, infoError: NO_LAN_IPS_MESSAGE });
          return null;
        }
        setState({ networkInfo: info, infoError: null });
        return null;
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ networkInfo: null, infoError: message });
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};

const buildGuestUrl = (ips: string[], port: number, fallbackOrigin: string): string => {
  const first = ips[0];
  if (typeof first === 'string' && first !== '') {
    return `http://${first}:${port}/guest`;
  }
  return `${fallbackOrigin}/guest`;
};

const PLACEHOLDER_STYLE = {
  width: QR_RENDER_SIZE / 2,
  height: QR_RENDER_SIZE / 2,
} as const;

const GuestQrPlaceholder = () => (
  <div aria-hidden="true" className="animate-pulse rounded-md bg-muted" style={PLACEHOLDER_STYLE} />
);

type GuestQrImageProps = {
  url: string;
};

const GuestQrImage = ({ url }: GuestQrImageProps) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      width: QR_RENDER_SIZE,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((generated) => {
        if (cancelled) {
          return null;
        }
        setDataUrl(generated);
        return null;
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return null;
        }
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error !== null) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        Could not generate QR: {error}
      </div>
    );
  }

  if (dataUrl === null) {
    return <GuestQrPlaceholder />;
  }

  return (
    <img
      src={dataUrl}
      alt={`QR code linking to ${url}`}
      width={QR_RENDER_SIZE / 2}
      height={QR_RENDER_SIZE / 2}
      className="rounded-md bg-white p-1 ring-1 ring-foreground/10"
    />
  );
};

const GuestQrImageArea = ({ guestUrl }: { guestUrl: string | null }) => {
  if (guestUrl === null) {
    return <GuestQrPlaceholder />;
  }
  return <GuestQrImage url={guestUrl} />;
};

type GuestQrFallbackHintProps = {
  origin: string;
  loopback: boolean;
};

const GuestQrFallbackHint = ({ origin, loopback }: GuestQrFallbackHintProps) => {
  if (loopback) {
    return (
      <p className="text-muted-foreground">
        Server didn&apos;t report any LAN IPv4 addresses. The QR currently points to{' '}
        <code className="font-mono">{origin}</code> — that&apos;s a loopback address, so phones on
        the LAN can&apos;t reach it. Make sure the server was started with the guest QR generator
        (see <code className="font-mono">scripts/start-test-server.bat</code>).
      </p>
    );
  }
  return (
    <p className="text-muted-foreground">
      Server didn&apos;t report any LAN IPv4 addresses. The QR currently points to{' '}
      <code className="font-mono">{origin}</code>; regenerate the QR after moving the server to a
      new network.
    </p>
  );
};

const AdditionalLanIps = ({ ips }: { ips: string[] }) => {
  const rest = ips.slice(1);
  if (rest.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground">
      Other LAN IPs reachable from this machine:{' '}
      {rest.map((ip, idx) => (
        <span key={ip}>
          {idx > 0 ? ', ' : ''}
          <code className="font-mono">{ip}</code>
        </span>
      ))}
      .
    </p>
  );
};

type BrowserHost = {
  origin: string;
  hostname: string;
};

const readBrowserHost = (): BrowserHost => {
  if (typeof window === 'undefined') {
    return { origin: '', hostname: '' };
  }
  return { origin: window.location.origin, hostname: window.location.hostname };
};

const readPort = (networkInfo: NetworkInfo | null): number => {
  const port = networkInfo?.port ?? 8080;
  return port;
};

const readLanIps = (networkInfo: NetworkInfo | null): string[] => {
  const ips = networkInfo?.lanIps ?? [];
  return ips;
};

type GuestUrlState = {
  origin: string;
  port: number;
  lanIps: string[];
  usingFallback: boolean;
  guestUrl: string | null;
  displayUrl: string;
};

const useGuestUrlState = (networkInfo: NetworkInfo | null): GuestUrlState => {
  const host = readBrowserHost();
  const port = readPort(networkInfo);
  const lanIps = readLanIps(networkInfo);
  const loaded = networkInfo !== null;
  const usingFallback = !loaded || lanIps.length === 0;
  const guestUrl = loaded ? buildGuestUrl(lanIps, port, host.origin) : null;
  const displayUrl = guestUrl ?? 'Loading…';
  return {
    origin: host.origin,
    port,
    lanIps,
    usingFallback,
    guestUrl,
    displayUrl,
  };
};

const useHostContext = () => {
  const host = readBrowserHost();
  const loopback = isLoopbackHost(host.hostname);
  return { origin: host.origin, loopback };
};

/**
 * Renders a QR code for the guest URL so a host can show their screen to a
 * phone on the same network and let the guest open the read-only guest view
 * by scanning.
 *
 * The encoded URL is taken from `/api/network-info` (which lists the host's
 * LAN IPs, populated by the guest QR generator at server startup). When the
 * host is browsing from a loopback address, the QR still points to the LAN
 * IP so guests on the LAN can reach it; when the LAN IPs aren't known, the
 * QR falls back to whatever origin the host is browsing from.
 */
export const GuestQrPanel = () => {
  const { networkInfo, infoError } = useNetworkInfo();
  const urlState = useGuestUrlState(networkInfo);
  const host = useHostContext();

  const showAdditionalLanIps = urlState.lanIps.length > 1;
  const showFallbackHint = urlState.usingFallback;
  const showInfoErrorNote = infoError !== null && !urlState.usingFallback;

  return (
    <Card className="mx-3 mb-3 sm:mx-4 sm:mb-4" data-size="sm">
      <CardHeader>
        <CardTitle>Share with guests</CardTitle>
        <CardDescription>
          Point a phone camera at the code to open the guest view on this library.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4">
        <GuestQrImageArea guestUrl={urlState.guestUrl} />
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">URL</span>
            <code className="break-all rounded bg-muted px-2 py-1 font-mono text-foreground">
              {urlState.displayUrl}
            </code>
          </div>
          {showAdditionalLanIps && <AdditionalLanIps ips={urlState.lanIps} />}
          {showFallbackHint && (
            <GuestQrFallbackHint origin={host.origin} loopback={host.loopback} />
          )}
          {showInfoErrorNote && <p className="text-muted-foreground">Note: {infoError}</p>}
        </div>
      </CardContent>
    </Card>
  );
};
