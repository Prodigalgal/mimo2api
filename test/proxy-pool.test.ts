import { describe, expect, it } from "vitest";
import { chooseProxyNode, decodeSubscription } from "../src/proxy/pool.js";

describe("proxy pool", () => {
  it("uses every node once before beginning another cycle", () => {
    const nodes = [{ tag: "a" }, { tag: "b" }, { tag: "c" }];
    const used = new Set<string>();

    expect(chooseProxyNode(nodes, used, () => 0).tag).toBe("a");
    expect(chooseProxyNode(nodes, used, () => 0).tag).toBe("b");
    expect(chooseProxyNode(nodes, used, () => 0).tag).toBe("c");
    expect(chooseProxyNode(nodes, used, () => 0).tag).toBe("a");
  });

  it("decodes plain and base64 subscriptions", () => {
    const subscription = "vless://one\nvless://two";
    expect(decodeSubscription(subscription)).toEqual(["vless://one", "vless://two"]);
    expect(decodeSubscription(Buffer.from(subscription).toString("base64"))).toEqual(["vless://one", "vless://two"]);
  });
});
