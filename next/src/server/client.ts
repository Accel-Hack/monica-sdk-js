import { createNodeClient } from "@ah-monica/node";
import type { CaptureContext } from "@ah-monica/node";
import type {
  MonicaNextServerClient,
  NextRequestErrorContext,
  NextRequestErrorRequest,
  NextServerClientOptions,
} from "./types.js";

export function createNextServerClient(
  options: NextServerClientOptions,
): MonicaNextServerClient {
  const node = createNodeClient(options);

  async function captureRequestError(
    error: unknown,
    _request: NextRequestErrorRequest,
    context: NextRequestErrorContext,
    captureContext: CaptureContext = {},
  ): Promise<string | null> {
    try {
      const nextContext = compact({
        routerKind: context.routerKind,
        routePath: context.routePath,
        routeType: context.routeType,
        renderSource: context.renderSource,
        revalidateReason: context.revalidateReason,
        renderType: context.renderType,
      });
      const eventId = await node.captureException(error, {
        ...captureContext,
        tags: {
          ...captureContext.tags,
          "next.router_kind": context.routerKind,
          "next.route_type": context.routeType,
        },
        contexts: {
          ...captureContext.contexts,
          next: nextContext,
        },
      });
      await node.flush();
      return eventId;
    } catch {
      // Observability must never make a Next.js request fail.
      return null;
    }
  }

  async function onRequestError(
    error: unknown,
    request: NextRequestErrorRequest,
    context: NextRequestErrorContext,
  ): Promise<void> {
    await captureRequestError(error, request, context);
  }

  return { ...node, captureRequestError, onRequestError };
}

function compact(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
