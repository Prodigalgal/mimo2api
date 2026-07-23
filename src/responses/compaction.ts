import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { ApiError } from "../core/errors.js";

export class CompactionCodec {
  readonly #key: Buffer;

  constructor(seed: string) {
    this.#key = createHash("sha256").update(seed).digest();
  }

  encode(items: Array<Record<string, any>>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(deflateSync(Buffer.from(JSON.stringify(items)))), cipher.final()]);
    return Buffer.concat([Buffer.from("m2c2"), iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  decode(value: string): Array<Record<string, any>> {
    try {
      const packed = Buffer.from(value, "base64url");
      if (packed.subarray(0, 4).toString() !== "m2c2") throw new Error("unsupported compaction version");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, packed.subarray(4, 16));
      decipher.setAuthTag(packed.subarray(16, 32));
      const plaintext = inflateSync(Buffer.concat([decipher.update(packed.subarray(32)), decipher.final()]));
      const items = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(items)) throw new Error("payload is not an item list");
      return items;
    } catch (error) {
      throw new ApiError(400, "invalid_compaction_item", `invalid compaction item: ${error instanceof Error ? error.message : error}`);
    }
  }
}
