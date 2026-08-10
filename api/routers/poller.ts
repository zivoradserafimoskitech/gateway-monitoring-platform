import { createRouter, authed } from "../middleware";
import { getPollerStatus } from "../poller/service";

export const pollerRouter = createRouter({
  status: authed.query(() => getPollerStatus()),
});
