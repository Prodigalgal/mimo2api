import { describe, expect, it } from "vitest";
import { chooseProxyNode, decodeSubscription, proxyNodeIdentity } from "../src/proxy/pool.js";

describe("proxy pool", () => {
  it("uses every node once before beginning another cycle", () => {
    const nodes = [
      { identity: "name:node-a", tag: "old-endpoint" },
      { identity: "name:node-b", tag: "new-endpoint" },
      { identity: "name:node-c", tag: "another-endpoint" },
    ];
    const used = new Set<string>();

    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("name:node-a");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("name:node-b");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("name:node-c");
    expect(chooseProxyNode(nodes, used, () => 0).identity).toBe("name:node-a");
  });

  it("decodes plain and base64 subscriptions", () => {
    const subscription = "vless://one\nvless://two";
    expect(decodeSubscription(subscription)).toEqual(["vless://one", "vless://two"]);
    expect(decodeSubscription(Buffer.from(subscription).toString("base64"))).toEqual(["vless://one", "vless://two"]);
  });

  it("keeps a named node identity stable when its dynamic endpoint changes", () => {
    const first = new URL("vless://user@first.example:443?security=tls#Tokyo");
    const second = new URL("vless://user@second.example:443?security=tls#Tokyo");
    expect(proxyNodeIdentity(first)).toBe(proxyNodeIdentity(second));
  });
});
