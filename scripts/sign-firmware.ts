// Reference signer for the build pipeline (NOT run by the platform).
//   OTA_SIGNING_PRIVATE_KEY_PEM=... npx tsx scripts/sign-firmware.ts <model> <version> <image>
// Prints sha256 and the base64 signature to paste into the release form.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { manifest } from "../api/ota/signing";

const [model, version, image] = process.argv.slice(2);
const pem = process.env.OTA_SIGNING_PRIVATE_KEY_PEM;
if (!model || !version || !image || !pem) {
  console.error("usage: OTA_SIGNING_PRIVATE_KEY_PEM=… sign-firmware.ts <model> <version> <image>");
  process.exit(1);
}
const sha256 = createHash("sha256").update(readFileSync(image)).digest("hex");
const signature = sign(null, Buffer.from(manifest(model, version, sha256)), createPrivateKey(pem)).toString("base64");
console.log(JSON.stringify({ sha256, signature }, null, 2));
