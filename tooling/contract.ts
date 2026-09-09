/**
 * vendoring した公開契約バンドル（spec/v1/）を契約テストから読むための共通部品。
 *
 * バンドルの正本は MONICA 本体にあり、ここにあるのは配信元
 * https://spec.monica.accelhack.net/v1/ から取り込んだコピー。
 * 各 package の test/contract.test.ts はこのコピーに対してオフラインで走る。
 * コピーの更新は tooling/spec-sync.ts が行う。
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import ajv2020 from "ajv/dist/2020.js";

// ajv は CommonJS で出荷されている。ESM から読むと default が module 全体になる
// 環境と class になる環境があるので、両方で class に着地する形で取り出す
const Ajv2020 = ajv2020.default ?? ajv2020;

export const SPEC_DIR = resolve(import.meta.dir, "..", "spec", "v1");

export type JsonObject = Record<string, unknown>;

export interface Limits {
  envelope_gzip_bytes: number;
  envelope_decompressed_bytes: number;
  items_per_envelope: number;
  frames_per_stacktrace: number;
}

export interface EnvelopeVector {
  description: string;
  /** MONICA が受理するか */
  valid: boolean;
  /**
   * 公開 JSON Schema が拒否するか。無ければ `!valid` と同じ。
   * `false` は「schema は通るが MONICA は拒否する」（暦として不正な日付など、
   * schema が形しか検査できないもの）。
   */
  schema_rejects?: boolean;
  envelope: unknown;
}

export async function readSpecJson<T>(path: string): Promise<T> {
  return (await Bun.file(resolve(SPEC_DIR, path)).json()) as T;
}

export async function readEnvelopeSchema(): Promise<JsonObject> {
  return readSpecJson<JsonObject>("envelope.json");
}

export async function readLimits(): Promise<Limits> {
  return readSpecJson<Limits>("limits.json");
}

export async function readEnvelopeVectors(): Promise<Array<EnvelopeVector & { file: string }>> {
  const directory = resolve(SPEC_DIR, "vectors", "envelope");
  const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      ...(await readSpecJson<EnvelopeVector>(`vectors/envelope/${file}`)),
    })),
  );
}

/**
 * envelope.json を draft 2020-12 として compile した validator。
 *
 * `format` は検査しない。バンドルは format を注記として扱い、timestamp の
 * RFC 3339 判定などは MONICA 側だけが行うと決めている（payload.md）。
 * ここで format を assertion すると、test vectors の期待値が validator 次第で
 * 変わってしまう。
 */
export async function compileEnvelopeValidator(): Promise<ValidateFunction> {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  return ajv.compile(await readEnvelopeSchema());
}

/** validator の失敗理由を 1 行にする。テストの失敗メッセージ用 */
export function describeErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "$"} ${error.message ?? ""}`.trim())
    .join("; ");
}

/** `$defs.errorItem.properties.<name>` を読む。無ければテストを落とす */
export function errorItemProperty(schema: JsonObject, name: string): JsonObject {
  const defs = schema.$defs as Record<string, JsonObject>;
  const properties = defs.errorItem?.properties as Record<string, JsonObject> | undefined;
  const property = properties?.[name];
  if (!property) throw new Error(`envelope.json has no $defs.errorItem.properties.${name}`);
  return property;
}

export function definition(schema: JsonObject, name: string): JsonObject {
  const defs = schema.$defs as Record<string, JsonObject>;
  const found = defs[name];
  if (!found) throw new Error(`envelope.json has no $defs.${name}`);
  return found;
}

export function enumOf(property: JsonObject): string[] {
  const values = property.enum;
  if (!Array.isArray(values)) throw new Error("property has no enum");
  return values as string[];
}

/** gzip された request body を envelope に戻す */
export async function decodeGzipBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("request has no body");
  return new Response(request.body.pipeThrough(new DecompressionStream("gzip"))).json();
}
