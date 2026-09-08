import { describe, expect, test } from "bun:test";
import { createNextServerClient } from "../src/server/client.js";

describe("createNextServerClient", () => {
  test("adapts Next onRequestError without collecting request PII", async () => {
    let request: Request | undefined;
    const client = createNextServerClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "production",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.onRequestError(
      new Error("server render failed"),
      {
        path: "/users/user@example.com?token=secret",
        method: "GET",
        headers: { cookie: "session=secret" },
      },
      {
        routerKind: "App Router",
        routePath: "/users/[id]/page",
        routeType: "render",
        renderSource: "react-server-components",
      },
    );

    const envelope = await readEnvelope(request);
    const item = envelope.items[0];
    expect(item).toMatchObject({
      platform: "node",
      message: "server render failed",
      tags: {
        "next.router_kind": "App Router",
        "next.route_type": "render",
      },
      contexts: {
        next: {
          routerKind: "App Router",
          routePath: "/users/[id]/page",
          routeType: "render",
          renderSource: "react-server-components",
        },
      },
    });
    expect(JSON.stringify(item)).not.toContain("user@example.com");
    expect(JSON.stringify(item)).not.toContain("session=secret");
  });

  test("merges reviewed application context", async () => {
    let request: Request | undefined;
    const client = createNextServerClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 202 });
      },
    });

    await client.captureRequestError(
      new Error("route failed"),
      { path: "/jobs/1", method: "POST", headers: {} },
      { routerKind: "App Router", routePath: "/jobs/[id]/route", routeType: "route" },
      { tags: { operation: "create-job" }, contexts: { app: { tenant: "reviewed" } } },
    );

    const item = (await readEnvelope(request)).items[0];
    expect(item?.tags).toMatchObject({ operation: "create-job" });
    expect(item?.contexts).toMatchObject({ app: { tenant: "reviewed" } });
  });

  test("never lets a malformed exception fail the Next request", async () => {
    const client = createNextServerClient({
      dsn: "https://msk_test@ingest.example.test/project-sample",
      environment: "test",
      fetch: async () => new Response(null, { status: 202 }),
    });
    const error = new Error("hostile error");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack getter failed");
      },
    });

    await expect(
      client.onRequestError(
        error,
        { path: "/", method: "GET", headers: {} },
        { routerKind: "App Router", routePath: "/page", routeType: "render" },
      ),
    ).resolves.toBeUndefined();
  });
});

interface CapturedEnvelope {
  items: Array<{
    platform: string;
    message?: string;
    tags?: Record<string, string>;
    contexts?: Record<string, unknown>;
  }>;
}

async function readEnvelope(request: Request | undefined): Promise<CapturedEnvelope> {
  if (!request?.body) throw new Error("MONICA request was not captured");
  const stream = request.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json() as Promise<CapturedEnvelope>;
}
