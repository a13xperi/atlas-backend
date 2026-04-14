jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from "../../lib/logger";
import { startBriefingCron, stopBriefingCron } from "../../../../cron/briefing";

describe("startBriefingCron", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    stopBriefingCron();
  });

  afterEach(() => {
    stopBriefingCron();
    jest.useRealTimers();
  });

  it("registers without throwing", () => {
    expect(() => startBriefingCron()).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith("[briefing-cron] registered");
  });
});
