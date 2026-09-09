import type { CaptureContext, MonicaNodeClient, NodeClientOptions } from "@ah-monica/node";

export type NextServerClientOptions = NodeClientOptions;

export interface NextRequestErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface NextRequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
  [key: string]: unknown;
}

export type NextRequestErrorHandler = (
  error: unknown,
  request: NextRequestErrorRequest,
  context: NextRequestErrorContext,
) => Promise<void>;

export interface MonicaNextServerClient extends MonicaNodeClient {
  /**
   * Next.js instrumentation `onRequestError` handler. It deliberately does not collect
   * request paths or headers; applications can add reviewed values through `beforeSend`.
   */
  onRequestError: NextRequestErrorHandler;
  captureRequestError(
    error: unknown,
    request: NextRequestErrorRequest,
    context: NextRequestErrorContext,
    captureContext?: CaptureContext,
  ): Promise<string | null>;
}
