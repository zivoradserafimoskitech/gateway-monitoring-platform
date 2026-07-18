import { relations } from "drizzle-orm";
import { sites, gateways, meters, telemetry, alarmRules, alarms, commands } from "./schema";

export const sitesRelations = relations(sites, ({ many }) => ({
  gateways: many(gateways),
}));

export const gatewaysRelations = relations(gateways, ({ one, many }) => ({
  site: one(sites, { fields: [gateways.siteId], references: [sites.id] }),
  meters: many(meters),
  alarms: many(alarms),
  commands: many(commands),
}));

export const metersRelations = relations(meters, ({ one, many }) => ({
  gateway: one(gateways, { fields: [meters.gatewayId], references: [gateways.id] }),
  telemetry: many(telemetry),
  alarms: many(alarms),
}));

export const telemetryRelations = relations(telemetry, ({ one }) => ({
  meter: one(meters, { fields: [telemetry.meterId], references: [meters.id] }),
}));

export const alarmRulesRelations = relations(alarmRules, ({ one, many }) => ({
  meter: one(meters, { fields: [alarmRules.meterId], references: [meters.id] }),
  alarms: many(alarms),
}));

export const alarmsRelations = relations(alarms, ({ one }) => ({
  rule: one(alarmRules, { fields: [alarms.ruleId], references: [alarmRules.id] }),
  meter: one(meters, { fields: [alarms.meterId], references: [meters.id] }),
  gateway: one(gateways, { fields: [alarms.gatewayId], references: [gateways.id] }),
}));

export const commandsRelations = relations(commands, ({ one }) => ({
  gateway: one(gateways, { fields: [commands.gatewayId], references: [gateways.id] }),
  meter: one(meters, { fields: [commands.meterId], references: [meters.id] }),
}));
