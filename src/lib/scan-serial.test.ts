import { describe, expect, it } from "vitest";
import { parseScannedSerial } from "./scan-serial";
import { urlBase64ToUint8Array } from "./push";

describe("parseScannedSerial", () => {
  it("handles the label formats seen in the field", () => {
    expect(parseScannedSerial("C30-00A1B2")).toBe("C30-00A1B2");
    expect(parseScannedSerial("SN: 2311HX0042")).toBe("2311HX0042");
    expect(parseScannedSerial("S/N 2311HX0042")).toBe("2311HX0042");
    expect(parseScannedSerial("https://vendor.example/device?sn=ABC12345&x=1")).toBe("ABC12345");
    expect(parseScannedSerial("https://vendor.example/d/ABC12345")).toBe("ABC12345");
    expect(parseScannedSerial("Model: G30\nSerial No. GW77001\nFW: 1.2")).toBe("GW77001");
  });
  it("rejects junk", () => {
    expect(parseScannedSerial("")).toBeNull();
    expect(parseScannedSerial("hello world !!")).toBeNull();
    expect(parseScannedSerial("ab")).toBeNull();
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url", () => {
    expect([...urlBase64ToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });
});
