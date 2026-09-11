// Outbound-URL guard for webhook notification channels. A user-supplied URL
// that the server fetches is a server-side request forgery path, so the guard
// must reject private space by default and allow it only on explicit opt-in.
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isPrivateAddress, parseEgressUrl, BlockedEgressError } from "../api/lib/egress";

describe("isPrivateAddress", () => {
  test("blocks IPv4 private, loopback and link-local space", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // carrier-grade NAT
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  test("allows ordinary public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "203.0.113.10", "172.32.0.1", "192.167.1.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  test("blocks IPv6 loopback, unique-local and link-local", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  test("IPv4-mapped IPv6 inherits the IPv4 verdict", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("anything that is not an address is refused", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("parseEgressUrl", () => {
  beforeEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  });
  afterEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  });

  test("accepts a plain https URL", () => {
    expect(parseEgressUrl("https://hooks.example.com/abc").hostname).toBe("hooks.example.com");
  });

  test("rejects http, embedded credentials and literal private addresses", () => {
    expect(() => parseEgressUrl("http://hooks.example.com/abc")).toThrow(BlockedEgressError);
    expect(() => parseEgressUrl("https://user:pass@hooks.example.com/")).toThrow(BlockedEgressError);
    expect(() => parseEgressUrl("https://169.254.169.254/latest/meta-data")).toThrow(BlockedEgressError);
    expect(() => parseEgressUrl("https://127.0.0.1:8080/x")).toThrow(BlockedEgressError);
  });

  test("rejects a non-URL", () => {
    expect(() => parseEgressUrl("not a url")).toThrow(BlockedEgressError);
  });

  test("WEBHOOK_ALLOW_PRIVATE opts an on-premise install back in", () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "true";
    expect(parseEgressUrl("http://10.0.0.5:9000/collect").hostname).toBe("10.0.0.5");
  });
});
