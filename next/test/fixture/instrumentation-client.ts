import { createNextClient } from "@ah-monica/next/client";

const monica = createNextClient({
  dsn: "https://mpk_build_test@ingest.example.test/project",
  environment: "test",
});

monica.installGlobalHandlers();
