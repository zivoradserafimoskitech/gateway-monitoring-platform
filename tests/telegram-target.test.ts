// A Telegram channel target is "<botToken>:<chatId>", and the bot token ITSELF
// contains a colon. Splitting on the first colon produced token="123456789"
// and chatId="AAH..." and every send failed, while the old validation regex
// rejected every real token outright.
import { test, expect } from "vitest";
import { parseTelegramTarget } from "../api/alarms/notify";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

test("parses a real bot token followed by a negative group id", () => {
  expect(parseTelegramTarget(`${TOKEN}:-1001234567890`)).toEqual({
    token: TOKEN,
    chatId: "-1001234567890",
  });
});

test("parses a positive private chat id", () => {
  expect(parseTelegramTarget(`${TOKEN}:42424242`)).toEqual({ token: TOKEN, chatId: "42424242" });
});

test("parses an @channelname target", () => {
  expect(parseTelegramTarget(`${TOKEN}:@volttrade_alarms`)).toEqual({
    token: TOKEN,
    chatId: "@volttrade_alarms",
  });
});

test("rejects a bare token with no chat id", () => {
  expect(parseTelegramTarget(TOKEN)).toBeNull();
});

test("rejects a malformed token", () => {
  expect(parseTelegramTarget("notanumber:secret:-100123")).toBeNull();
  expect(parseTelegramTarget("123456789:short:-100123")).toBeNull();
});

test("rejects a chat id that is neither numeric nor an @name", () => {
  expect(parseTelegramTarget(`${TOKEN}:not a chat`)).toBeNull();
});

test("rejects empty and separator-only input", () => {
  expect(parseTelegramTarget("")).toBeNull();
  expect(parseTelegramTarget(":")).toBeNull();
  expect(parseTelegramTarget(`${TOKEN}:`)).toBeNull();
});
