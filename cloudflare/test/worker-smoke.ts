import { createCloudflareClient } from "../dist/index.js";

export default {
  async fetch(): Promise<Response> {
    let capturedRequest: Request | undefined;
    let capturedMessage: string | undefined;
    const client = createCloudflareClient({
      dsn: "https://msk_smoke@ingest.example.test/project-smoke",
      environment: "test",
      fetch: async (input, init) => {
        capturedRequest = new Request(input, init);
        if (!capturedRequest.body) throw new Error("capture body is missing");
        const stream = capturedRequest.body.pipeThrough(new DecompressionStream("gzip"));
        const envelope = (await new Response(stream).json()) as {
          items?: Array<{ message?: string }>;
        };
        capturedMessage = envelope.items?.[0]?.message;
        return new Response(null, { status: 202 });
      },
    });
    const eventId = await client.captureMessage("runtime smoke");
    return Response.json({
      eventId,
      authorization: capturedRequest?.headers.get("Authorization"),
      encoding: capturedRequest?.headers.get("Content-Encoding"),
      message: capturedMessage,
    });
  },
};
