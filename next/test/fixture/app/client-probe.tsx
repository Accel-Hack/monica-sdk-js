"use client";

import { createNextClient } from "@ah-monica/next/client";

const monica = createNextClient({
  dsn: "https://mpk_build_test@ingest.example.test/project",
  environment: "test",
});

export function ClientProbe() {
  return (
    <button type="button" onClick={() => void monica.captureMessage("fixture clicked")}>
      client probe
    </button>
  );
}
