import type { Instrumentation } from "next";

// README の例と同じ形。Edge 向けの bundle に server client を含めない
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./monica.server");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { monica } = await import("./monica.server");
  await monica.onRequestError(...args);
};
