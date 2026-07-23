import type { MimoAccount } from "../config/types.js";
import { ApiError } from "../core/errors.js";
import { MimoClient } from "../mimo/client.js";

export class AccountValidator {
  readonly timeoutMs = Math.max(30_000, Number(process.env.MIMO2API_ACCOUNT_TEST_TIMEOUT_MS ?? 90_000));

  async validate(account: MimoAccount, signal: AbortSignal): Promise<MimoAccount> {
    if (!account.service_token || !account.user_id || !account.xiaomichatbot_ph) {
      throw new ApiError(400, "account_credentials_missing", "account is missing MiMo service credentials");
    }
    const client = new MimoClient(account);
    let hasText = false;
    for await (const event of client.stream({
      query: "Reply exactly: OK",
      model: "mimo-v2.5-pro",
      thinking: false,
    }, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]))) {
      if (event.type === "text" && event.text.trim()) hasText = true;
    }
    if (!hasText) throw new ApiError(502, "account_validation_empty", "MiMo validation completed without text output");
    return {
      ...account,
      is_valid: true,
      last_test: new Date().toISOString(),
      renew_error: "",
    };
  }
}
