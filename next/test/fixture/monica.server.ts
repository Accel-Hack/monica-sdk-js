import { createNextServerClient } from "@ah-monica/next/server";

export const monica = createNextServerClient({
  dsn: "https://msk_build_test@ingest.example.test/project",
  environment: "test",
});
