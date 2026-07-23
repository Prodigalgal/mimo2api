import { describe, expect, it } from "vitest";
import { chooseProxyNode, decodeSubscription } from "../src/proxy/pool.js";

describe("proxy pool", () => {
  it("uses every node once before beginning another cycle", () => {
    const nodes = [
      { identity: "node-a", tag: "same" },
      { identity: "node-b", tag: "same" },
      { identity: "node-c", tag: "same" },
    ];
    const used = new Set<string>();

    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("node-a");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("node-b");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("node-c");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("node-a");
  });

  it("decodes plain and base64 subscriptions", () => {
    const subscription = "vless://one\nvless://two";
    expect(decodeSubscription(subscription)).toEqual(["vless://one", "vless://two"]);
    expect(decodeSubscription(Buffer.from(subscription).toString("base64"))).toEqual(["vless://one", "vless://two"]);
  });
});
