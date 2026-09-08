import { createNextServerClient } from "@ah-monica/next/server";

const monica = createNextServerClient({
  dsn: "https://msk_build_test@ingest.example.test/project",
  environment: "test",
});

export const onRequestError = monica.onRequestError;
